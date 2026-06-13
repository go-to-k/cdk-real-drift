// The heart of `check`: given a resource's resolved declared properties, its raw
// live state, and its schema info, classify every difference into a tier:
//   declared    — a declared property whose live value differs
//   undeclared  — a live property not declared, after noise subtraction (the differentiator)
//   readGap     — a declared property absent from the live read (CC-API can't read it back)
//   unresolved  — a declared property whose intrinsics couldn't be resolved (GetAtt) → skip
//
// Pure: no AWS calls. liveRaw is the CC API GetResource model (un-stripped).

import { isArnNameMatch, isManagedKmsAliasMatch } from '../normalize/arn-identity.js';
import { stripCcApiAwsManagedFields } from '../normalize/cc-api-strip.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import {
  CASE_INSENSITIVE_PATHS,
  isAllAwsTags,
  isCaseInsensitiveScalarEqual,
  isEqualUnorderedScalarSet,
  isJsonStringStructEqual,
  isStringlyEqualScalar,
  isTrivialEmpty,
  KNOWN_DEFAULTS,
  projectLiveToDeclaredSubset,
  sortUnorderedObjectArray,
  stripAwsTagsDeep,
  UNORDERED_ARRAY_PROPS,
  UNORDERED_OBJECT_ARRAY_PROPS,
} from '../normalize/noise.js';
import { deepStripPaths } from '../normalize/path-strip.js';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import type { DesiredResource, Finding, SchemaInfo } from '../types.js';
import { calculateResourceDrift, deepEqual } from './drift-calculator.js';

// R78: identity-keyed attribute bags whose declared drift must be reverted BY KEY
// (the index-based Cloud Control patch misaligns against the full live bag and ELB
// caps a modify at 20 attributes). Maps the resource type to its bag property; a
// drift inside the bag emits one declared finding per changed Key (path stays at
// the bag property, the Key rides on Finding.attributeKey for the SDK writer).
const ELB_ATTRIBUTE_BAGS: Record<string, string> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'LoadBalancerAttributes',
  'AWS::ElasticLoadBalancingV2::TargetGroup': 'TargetGroupAttributes',
};
const isKeyValueEntry = (t: unknown): t is { Key: string; Value: unknown } =>
  !!t &&
  typeof t === 'object' &&
  typeof (t as { Key?: unknown }).Key === 'string' &&
  'Value' in (t as object);

export function classifyResource(
  resource: DesiredResource,
  liveRaw: Record<string, unknown>,
  schema: SchemaInfo,
  opts: {
    accountId?: string;
    region?: string;
    kmsAliasTargets?: Record<string, string>; // alias/aws/* -> target key id, for strict KMS match
  } = {}
): Finding[] {
  const { logicalId, resourceType, physicalId, declared: declaredIn } = resource;
  const findings: Finding[] = [];

  // strip AWS-managed fields + drop aws:* tag elements (live-only), then run the
  // shared canonicalization pipeline (policy docs + tag lists + id arrays) on both
  // sides so reordering / scalar-vs-array is not false drift. The pipeline is shared
  // with baseline-file.ts so baseline values normalize identically (see pipeline.ts).
  const live = canonicalizeForCompare(
    stripAwsTagsDeep(stripCcApiAwsManagedFields(liveRaw))
  ) as Record<string, unknown>;
  const declared = canonicalizeForCompare(declaredIn) as Record<string, unknown>;
  // R11: a declared TOP-LEVEL write-only key is about to be stripped from `declared`
  // (below). Surface it as ONE readGap finding FIRST so it is never silently dropped
  // — the informational tier exists precisely for "declared but unreadable" props.
  // Only top-level keys get this treatment; nested write-only path stripping stays
  // silent on purpose (too granular to report meaningfully per-path).
  for (const k of Object.keys(declared)) {
    if (schema.writeOnly.has(k)) {
      findings.push({
        tier: 'readGap',
        logicalId,
        resourceType,
        path: k,
        note: 'write-only — cannot be read back',
      });
    }
  }
  // schema-driven noise removal at ANY depth: readOnly is pure noise (strip from
  // live); writeOnly cannot be read back (strip from BOTH sides so it is never
  // compared, at top level or nested).
  deepStripPaths(live, schema.readOnlyPaths);
  deepStripPaths(live, schema.writeOnlyPaths);
  deepStripPaths(declared, schema.writeOnlyPaths);

  // Sibling-managed inline Policies (the CDK pattern: grants land in a sibling
  // AWS::IAM::Policy resource, which reflects into the role's live Policies). Drop
  // ONLY the live entries owned by a sibling — their content drift is the sibling
  // resource's own finding — so an out-of-band inline policy added to the role
  // still surfaces (as undeclared, or inside the declared compare). 'unresolved'
  // (a sibling PolicyName we cannot resolve statically) falls back to suppressing
  // the whole property: no false positives over an unidentifiable sibling entry.
  const sibling = resource.siblingPolicyNames;
  if (sibling !== undefined && 'Policies' in live) {
    if (sibling === 'unresolved') {
      if (!('Policies' in declared)) delete live.Policies;
    } else if (Array.isArray(live.Policies)) {
      const names = new Set<unknown>(sibling);
      live.Policies = live.Policies.filter(
        (p) => !(p && typeof p === 'object' && names.has((p as Record<string, unknown>).PolicyName))
      );
    }
  }

  // declared drift (A3: declared key absent in live = read gap, not drift).
  // NOTE: no `schema.writeOnly.has(k)` guard here — a top-level write-only key was
  // already emitted as a readGap above AND stripped from `declared` by writeOnlyPaths,
  // so it cannot reach this loop (the old guard was dead code for top-level keys).
  const knownDef = KNOWN_DEFAULTS[resourceType] ?? {};
  for (const [k, v] of Object.entries(declared)) {
    if (v === UNRESOLVED || hasUnresolved(v)) {
      findings.push({ tier: 'unresolved', logicalId, resourceType, path: k });
      continue;
    }
    if (!(k in live)) {
      findings.push({
        tier: 'readGap',
        logicalId,
        resourceType,
        path: k,
        note: 'declared but not returned by live read',
      });
      continue;
    }
    // R78: ELB attribute bags compare BY KEY (the template declares a subset of
    // the keys AWS returns) and emit one declared finding per changed attribute
    // carrying its Key, so revert can send only that Key=Value. This is naturally
    // subset-aware, subsuming the R75 projection for these two types.
    if (k === ELB_ATTRIBUTE_BAGS[resourceType] && Array.isArray(v) && Array.isArray(live[k])) {
      const liveBag = live[k] as unknown[];
      for (const dEl of v) {
        if (!isKeyValueEntry(dEl)) continue;
        const lEl = liveBag.find((e) => isKeyValueEntry(e) && e.Key === dEl.Key);
        const liveValue = lEl ? (lEl as { Value: unknown }).Value : undefined;
        if (deepEqual(dEl.Value, liveValue)) continue;
        if (isStringlyEqualScalar(dEl.Value, liveValue)) continue;
        findings.push({
          tier: 'declared',
          logicalId,
          resourceType,
          path: k,
          attributeKey: dEl.Key,
          desired: dEl.Value,
          actual: liveValue,
        });
      }
      continue;
    }
    // Per-type unordered OBJECT-array sets (R88: EC2 SecurityGroup ingress/egress) —
    // rule objects with no single identity field that AWS returns reordered. Sort BOTH
    // sides by canonical JSON before the positional diff so a reorder is not false
    // drift; a genuine rule change still differs after the sort.
    const unorderedObjArray = UNORDERED_OBJECT_ARRAY_PROPS[resourceType]?.has(k);
    const declaredVal = unorderedObjArray ? sortUnorderedObjectArray(v) : v;
    const liveSorted = unorderedObjArray ? sortUnorderedObjectArray(live[k]) : live[k];
    // Identity-keyed attribute bags (R75: other bag-shaped props) — the template
    // declares a SUBSET of the keys AWS returns; compare only the declared keys so
    // the extra live attributes are not false drift on the whole list.
    const liveVal = projectLiveToDeclaredSubset(declaredVal, liveSorted);
    for (const d of calculateResourceDrift({ [k]: declaredVal }, { [k]: liveVal })) {
      // a bare name declared for a field AWS returns as the full ARN is not drift
      // (account/region-scoped when opts are provided); likewise an AWS-managed-default
      // KMS alias vs its resolved key ARN
      if (isArnNameMatch(d.stateValue, d.awsValue, opts)) continue;
      if (isManagedKmsAliasMatch(d.stateValue, d.awsValue, opts.kmsAliasTargets)) continue;
      // CFn stringly-typed scalar (Glue Parameters Map<String,String>, "5432" ports):
      // declared `true`/`5432` vs AWS `"true"`/`"5432"` is not drift.
      if (isStringlyEqualScalar(d.stateValue, d.awsValue)) continue;
      // A declared object whose live form is the same value as a JSON STRING
      // (R75: SSM Document.Content) — equal after parse, key-order-insensitive.
      if (isJsonStringStructEqual(d.stateValue, d.awsValue)) continue;
      // Per-type case-insensitive scalar paths (R75: Route53 AliasTarget.DNSName
      // — the ALB's generated DNS name is mixed-case declared, lowercase live).
      if (
        CASE_INSENSITIVE_PATHS[resourceType]?.has(d.path) &&
        isCaseInsensitiveScalarEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type unordered scalar-array sets (R74: Cognito UserPoolClient OAuth
      // flow/scope lists) — same elements in the service's canonical order is
      // not drift; a genuine element change still differs after sorting.
      if (
        UNORDERED_ARRAY_PROPS[resourceType]?.has(d.path) &&
        isEqualUnorderedScalarSet(d.stateValue, d.awsValue)
      )
        continue;
      // A declared trivially-EMPTY value that the service materializes as its
      // documented default is not drift (R74: CDK Trail declares EventSelectors
      // [] and CloudTrail returns the default management selector). Equality-
      // gated on BOTH sides: the declared side must be empty (a real declared
      // value mismatch is never muted) and the live side must EQUAL the listed
      // default (any out-of-band change still surfaces).
      if (
        isTrivialEmpty(d.stateValue) &&
        d.path in knownDef &&
        deepEqual(d.awsValue, knownDef[d.path])
      )
        continue;
      findings.push({
        tier: 'declared',
        logicalId,
        resourceType,
        path: d.path,
        desired: d.stateValue,
        actual: d.awsValue,
      });
    }
  }

  // undeclared (A1/A2/A4 + identity suppression)
  for (const [k, v] of Object.entries(live)) {
    if (k in declared) continue;
    // NOTE: no `schema.writeOnly.has(k)` guard — a top-level write-only key was
    // already stripped from `live` by writeOnlyPaths above, so it cannot reach here
    // (the old guard was dead code for top-level keys).
    // A live value EQUAL to a known AWS default is the `atDefault` tier (R86): still
    // surfaced (folded, never dropped — the report shows the complete undeclared
    // count and --show-all/--verbose lists them), but informational, not drift, and
    // not recorded by accept. The equality gate means an out-of-band change away from
    // the default no longer matches here and falls through to the `undeclared` tier.
    if (
      (k in schema.defaults && deepEqual(v, schema.defaults[k])) ||
      (k in knownDef && deepEqual(v, knownDef[k]))
    ) {
      findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // Pure structural noise (NOT a config value at default) — dropped outright: AWS
    // managed `aws:*` tags, the resource's own physical id echoed back as a property,
    // and trivially-empty {}/[]. These carry no inventory value, so they are not folded.
    if (isAllAwsTags(v)) continue;
    if (physicalId !== undefined && v === physicalId) continue;
    if (isTrivialEmpty(v)) continue;
    findings.push({ tier: 'undeclared', logicalId, resourceType, path: k, actual: v });
  }

  // attach physicalId (for revert) + construct path (display) onto every finding
  const cp = resource.constructPath;
  const pid = resource.physicalId;
  return findings.map((f) => ({
    ...f,
    ...(pid !== undefined && { physicalId: pid }),
    ...(cp !== undefined && { constructPath: cp }),
  }));
}

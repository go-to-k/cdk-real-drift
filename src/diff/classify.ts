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
  identityField,
  isCaseInsensitiveScalarEqual,
  isEqualUnorderedScalarSet,
  isJsonStringStructEqual,
  isPemEqual,
  isStringlyEqualScalar,
  isGeneratedName,
  isTrivialEmpty,
  KNOWN_DEFAULT_PATHS,
  KNOWN_DEFAULTS,
  resolveGeneratedDefault,
  sortUnorderedObjectArray,
  stripAwsTagsDeep,
  UNORDERED_ARRAY_PROPS,
  UNORDERED_OBJECT_ARRAY_PROPS,
} from '../normalize/noise.js';
import { deepStripPaths } from '../normalize/path-strip.js';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import { rewriteOaiPrincipalsDeep } from '../normalize/policy-canonical.js';
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

// R96/R98: recurse the declared and live sides of a property and emit each LIVE-only
// nested key — a sub-key present in live but never declared, at any depth.
//   - Plain objects (R96): walk every live key; recurse where declared, emit otherwise.
//   - Identity-keyed object arrays (R98: Tags/Origins/AttributeDefinitions/…): align
//     elements BY identity value (not position — canonicalization may sort the side
//     with an extra sub-key elsewhere) and recurse into each MATCHED pair, so a
//     live-only sub-field inside a declared element is caught (path `Prop[<id>].sub`).
//     A whole live-only ELEMENT (no declared match) is left to the declared compare,
//     not emitted here. Identity-LESS arrays (no shared Key/Id/AttributeName/IndexName,
//     e.g. SecurityGroup rules) are NOT descended — their elements can't be matched
//     reliably, so descending risks false positives.
// Pure: the caller decides suppression and finding shape.
const isNestedObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
function collectNestedUndeclared(
  declaredVal: unknown,
  liveVal: unknown,
  path: string,
  emit: (path: string, value: unknown) => void
): void {
  if (Array.isArray(declaredVal) && Array.isArray(liveVal)) {
    if (declaredVal.length === 0 || liveVal.length === 0) return;
    const idf = identityField(declaredVal);
    if (!idf || identityField(liveVal) !== idf) return;
    const liveById = new Map<string, Record<string, unknown>>();
    for (const el of liveVal) if (isNestedObject(el)) liveById.set(String(el[idf]), el);
    for (const dEl of declaredVal) {
      if (!isNestedObject(dEl)) continue;
      const match = liveById.get(String(dEl[idf]));
      if (match) collectNestedUndeclared(dEl, match, `${path}[${String(dEl[idf])}]`, emit);
    }
    return;
  }
  if (!isNestedObject(declaredVal) || !isNestedObject(liveVal)) return;
  for (const [k, val] of Object.entries(liveVal)) {
    const childPath = `${path}.${k}`;
    if (k in declaredVal) collectNestedUndeclared(declaredVal[k], val, childPath, emit);
    else emit(childPath, val);
  }
}

export function classifyResource(
  resource: DesiredResource,
  liveRaw: Record<string, unknown>,
  schema: SchemaInfo,
  opts: {
    accountId?: string;
    region?: string;
    kmsAliasTargets?: Record<string, string>; // alias/aws/* -> target key id, for strict KMS match
    oaiCanonicalIds?: Record<string, string>; // OAI id -> S3CanonicalUserId, for CloudFront OAI principal match
  } = {}
): Finding[] {
  const { logicalId, resourceType, physicalId, declared: declaredIn } = resource;
  const findings: Finding[] = [];

  // strip AWS-managed fields + drop aws:* tag elements (live-only), then reconcile
  // CloudFront OAI principals (cloudfront:user ARN <-> CanonicalUser; no-op without
  // a resolved map) on BOTH sides, then run the shared canonicalization pipeline
  // (policy docs + tag lists + id arrays) so reordering / scalar-vs-array / OAI
  // principal-form is not false drift. The pipeline is shared with baseline-file.ts
  // so baseline values normalize identically (see pipeline.ts).
  const oaiMap = opts.oaiCanonicalIds ?? {};
  const live = canonicalizeForCompare(
    rewriteOaiPrincipalsDeep(stripAwsTagsDeep(stripCcApiAwsManagedFields(liveRaw)), oaiMap)
  ) as Record<string, unknown>;
  const declared = canonicalizeForCompare(rewriteOaiPrincipalsDeep(declaredIn, oaiMap)) as Record<
    string,
    unknown
  >;
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
  // still surfaces (as undeclared, or inside the declared compare).
  //
  // R111 fail-open: when a sibling PolicyName cannot be resolved statically (an
  // Fn::Sub/Fn::Join name, or none), `siblingPolicyNames` is 'unresolved' and we
  // do NOT filter at all. The old fallback DELETED the whole live Policies — which
  // also hid any out-of-band inline policy added directly to the role: a silent
  // false negative on a security-relevant resource (the dangerous DROP class, R95).
  // Now the unresolved role keeps its live Policies, so a rogue policy is NEVER
  // hidden; the sibling-managed entries surface as undeclared (baseline-able once).
  // We trade a one-time, VISIBLE false positive for never hiding a real change.
  const sibling = resource.siblingPolicyNames;
  if (sibling !== undefined && sibling !== 'unresolved' && Array.isArray(live.Policies)) {
    const names = new Set<unknown>(sibling);
    live.Policies = live.Policies.filter(
      (p) => !(p && typeof p === 'object' && names.has((p as Record<string, unknown>).PolicyName))
    );
  }

  // declared drift (A3: declared key absent in live = read gap, not drift).
  // NOTE: no `schema.writeOnly.has(k)` guard here — a top-level write-only key was
  // already emitted as a readGap above AND stripped from `declared` by writeOnlyPaths,
  // so it cannot reach this loop (the old guard was dead code for top-level keys).
  const knownDef = KNOWN_DEFAULTS[resourceType] ?? {};
  // AWS/CDK-generated values for THIS resource (its minted name, a default log group
  // derived from the physical id), with the live physical id substituted in — keyed
  // by property, consulted by the undeclared loop below. Empty when the type has no
  // template or the physical id is unknown.
  const genDef = resolveGeneratedDefault(resourceType, physicalId) ?? {};
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
    const liveVal = unorderedObjArray ? sortUnorderedObjectArray(live[k]) : live[k];
    // R95: the live side is compared in FULL — no subset projection. An R75
    // generic `projectLiveToDeclaredSubset` used to drop live elements whose
    // identity key was not declared, to mute the extra default attributes ELB
    // returns. But that ALSO silently dropped genuine out-of-band ADDITIONS to any
    // identity-keyed array — a console-added Tag, an extra CloudFront Origin — which
    // a drift tool must never hide (fail-closed: report, do not suppress). The ELB
    // attribute bags are handled above by ELB_ATTRIBUTE_BAGS (R78, compare BY KEY),
    // which subsumes the projection for the one type that needed it; the corpus
    // confirms no other type relied on it.
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
      // A PEM-armored value (R125: CloudFront PublicKey EncodedKey) that
      // round-trips with only surrounding-whitespace differences — AWS appends a
      // trailing newline after the END marker — is not drift.
      if (isPemEqual(d.stateValue, d.awsValue)) continue;
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
    // not recorded by record. The equality gate means an out-of-band change away from
    // the default no longer matches here and falls through to the `undeclared` tier.
    if (
      (k in schema.defaults && deepEqual(v, schema.defaults[k])) ||
      (k in knownDef && deepEqual(v, knownDef[k]))
    ) {
      findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // A live value EQUAL to the AWS/CDK-generated value for this resource (its minted
    // physical name, a default-named log group) is the `generated` tier: folded
    // inventory like atDefault, never drift, never recorded. Equality-gated against
    // the physical-id-substituted template, so an out-of-band edit (a different
    // LogFormat, say) no longer matches and falls through to `undeclared` below.
    if (k in genDef && deepEqual(v, genDef[k])) {
      findings.push({ tier: 'generated', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // R107: a scalar value that IS this resource's generated NAME from an ARN physical
    // id (the ARN's name segment — a topic's TopicName, a state machine's
    // StateMachineName) is the same `generated` tier — folded, never drift, never
    // recorded — for ANY type, without a per-type GENERATED_DEFAULTS entry. The bare
    // physical-id echo (value === physicalId) is left to the structural drop below.
    if (isGeneratedName(v, physicalId)) {
      findings.push({ tier: 'generated', logicalId, resourceType, path: k, actual: v });
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

  // Nested undeclared (R96): the Cloud Control read returns the FULL live model, so a
  // live SUB-key inside a DECLARED object that the template never set is just as
  // undeclared as a top-level one — recurse the declared∩live objects and emit each
  // live-only nested key (dotted path). Same noise suppression as the top-level loop
  // (trivially-empty / aws:* tags). These flow through the usual undeclared→baseline
  // machinery, just `nested`-flagged so the report can fold them (the live model
  // carries many nested AWS defaults): folded inventory on a first run, recorded by
  // record, and a later out-of-band change to one surfaces as drift vs the baseline.
  // R103: a nested value EQUAL to the schema's `default` at that path is the
  // `atDefault` tier (mirrors the top-level atDefault), so config-dense types stop
  // drowning the report in materialized defaults. Live array-element paths carry the
  // element identity (`Prop[<id>].sub`); the schema keys it with a `*` wildcard, so
  // normalize `[<id>]` -> `.*` before the lookup. Equality-gated: a value changed
  // AWAY from its default no longer matches and falls back to `undeclared`.
  // R108: KNOWN_DEFAULT_PATHS is the hand-coded twin for the nested service defaults
  // the CFn schema does NOT annotate (the nested analogue of KNOWN_DEFAULTS) — read
  // through the SAME wildcard lookup, equality-gated identically.
  const knownDefPaths = KNOWN_DEFAULT_PATHS[resourceType] ?? {};
  for (const [k, dv] of Object.entries(declared)) {
    if (dv === UNRESOLVED || hasUnresolved(dv) || !(k in live)) continue;
    collectNestedUndeclared(dv, live[k], k, (path, value) => {
      if (isAllAwsTags(value) || isTrivialEmpty(value)) return;
      const schemaPath = path.replace(/\[[^\]]*\]/g, '.*');
      const atDefault =
        (schemaPath in schema.defaultPaths && deepEqual(value, schema.defaultPaths[schemaPath])) ||
        (schemaPath in knownDefPaths && deepEqual(value, knownDefPaths[schemaPath]));
      const tier = atDefault ? 'atDefault' : 'undeclared';
      findings.push({ tier, logicalId, resourceType, path, actual: value, nested: true });
    });
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

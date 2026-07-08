// Shared read+classify pipeline used by both `check` and `record`.

import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { buildCorpusCase, CORPUS_DIR_ENV, recordCorpusCase } from '../corpus/record.js';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import { classifyResource, normalizeLiveModel } from '../diff/classify.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { READ_RETRY } from '../read/client-config.js';
import {
  fetchManagedAliasTargets,
  kmsListAliasesDeniedWarning,
  usesManagedKmsAlias,
} from '../read/kms-aliases.js';
import { type AddedChild, CHILD_ENUMERATORS } from '../read/child-enumerators.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import { CC_IDENTIFIER_ADAPTERS, readLive, type ReadResult } from '../read/router.js';
import { getSchemaInfo } from '../schema/schema-strip.js';
import type { DesiredResource, Finding, SchemaInfo } from '../types.js';

export interface GatherResult {
  desired: Desired;
  findings: Finding[];
  schemas: Map<string, SchemaInfo>; // resourceType -> schema (so revert can honor createOnly)
  // logicalId -> the UN-stripped live model (CC GetResource / SDK override read), kept so
  // the revert write path can see live-only data the compare-side strips — notably the
  // `aws:*` managed tags `stripAwsTagsDeep` removes, which a Tags revert must preserve on
  // the WRITE side (tagPreservingOps). Resources with no readable live model are absent.
  liveByLogical: Map<string, Record<string, unknown>>;
}

// Project the per-resource live reads into the logicalId -> live-model map carried on
// GatherResult (only the resources that actually read back a model).
function liveModelMap(reads: Map<string, ReadResult>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const [logicalId, read] of reads) if (read.live) out.set(logicalId, read.live);
  return out;
}

// Regions already warned about a denied kms:ListAliases — the warning is one-per-region
// (a multi-stack run in the same region should not repeat it). Process-lifetime (matches
// the per-region alias cache in kms-aliases.ts).
const kmsDeniedWarned = new Set<string>();

// Bounded-concurrency live-read pool (pull-next-when-free): serial reads cost
// ~300ms each, so 200+ resources took >1min; the SDK's adaptive retry handles
// any throttling. Stores each read in `reads` and feeds ctx.liveAttrs so
// Fn::GetAtt can resolve against real attributes.
const POOL_SIZE = 6;
async function readAll(
  cc: CloudControlClient,
  targets: DesiredResource[],
  region: string,
  desired: Desired,
  reads: Map<string, ReadResult>
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const r = targets[cursor++]!;
      const read = await readLive(cc, r, region, desired.accountId);
      reads.set(r.logicalId, read);
      if (read.live) desired.ctx.liveAttrs[r.logicalId] = read.live;
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL_SIZE, targets.length) }, () => worker()));
}

// Turn an enumerated out-of-band child into an `added` finding. logicalId is
// synthesized (the child is not in the template, so it has none) from the parent's
// logical id + the CC identifier — stable and unique. physicalId carries the CC
// identifier so revert can DeleteResource it; constructPath gives the report a
// readable label even when the parent has no CDK construct path.
//
// `actual` is the child's FULL, normalized live model (PR4): `added` is now
// record-able (the resource-level analog of recording an undeclared property), so the
// baseline snapshots this value and a later out-of-band CHANGE to the child surfaces
// as drift. The model is normalized identically to classify's live side
// (normalizeLiveModel) so a volatile readOnly field never reads as a false "changed
// since record". Falls back to the enumerator's identity-only snippet when the CC
// GetResource fails (so the resource is still reported, just not change-watchable).
function addedFinding(
  parent: DesiredResource,
  c: AddedChild,
  read: { model: Record<string, unknown>; ok: boolean }
): Finding {
  return {
    tier: 'added',
    logicalId: `${parent.logicalId}/${c.identifier}`,
    physicalId: c.identifier,
    constructPath: `${parent.constructPath ?? parent.logicalId} ▸ ${c.label}`,
    resourceType: c.resourceType,
    path: '',
    actual: read.model,
    note: read.ok
      ? 'created out of band — not in your CloudFormation template'
      : 'created out of band — not in your CloudFormation template; live model unreadable this run',
    // a degraded read carries only the identity snippet — not change-watchable this run
    ...(read.ok ? {} : { modelReadFailed: true }),
  };
}

// Read the added child's FULL live model via Cloud Control GetResource (its
// `identifier` is the CC composite, the same one revert's DeleteResource consumes) and
// normalize it for record/compare. On any read/parse error return the enumerator's
// identity-only `live` snippet with `ok: false` — the resource is still REPORTED as
// added, but the finding is flagged `modelReadFailed` so record skips snapshotting the
// partial model and applyBaseline never false-flags it as "changed" (a degraded snippet
// vs a recorded full model would otherwise differ). `cfn` fetches the child type's schema
// (readOnly/writeOnly strip); `schemas` is the shared cache.
async function readAddedModel(
  cc: CloudControlClient,
  cfn: CloudFormationClient,
  c: AddedChild,
  schemas: Map<string, SchemaInfo>,
  oaiCanonicalIds: Record<string, string>
): Promise<{ model: Record<string, unknown>; ok: boolean }> {
  try {
    const g = await cc.send(
      new GetResourceCommand({ TypeName: c.resourceType, Identifier: c.identifier })
    );
    const raw = JSON.parse(g.ResourceDescription?.Properties ?? '{}') as Record<string, unknown>;
    const schema = schemas.get(c.resourceType) ?? (await getSchemaInfo(cfn, c.resourceType));
    schemas.set(c.resourceType, schema);
    return {
      model: normalizeLiveModel(raw, schema, { oaiCanonicalIds, resourceType: c.resourceType }),
      ok: true,
    };
  } catch {
    return { model: c.live, ok: false };
  }
}

// A child enumerated off a declared parent but ABSENT from that parent's own template
// is only "out of band" if NO CloudFormation stack manages it. The common false
// positive is a cross-stack reference: a child resource CDK places in a SIBLING stack
// of the same app (e.g. `topic.addSubscription(new SqsSubscription(queue))` puts the
// `AWS::SNS::Subscription` in the QUEUE's stack to avoid a dependency cycle, so checking
// the TOPIC's stack finds a live subscription not in that template) — it is fully
// CFn-managed, just by a sibling (#666). DescribeStackResources resolves the owning stack
// account-wide from the physical id alone, so this fixes both single-stack and multi-stack
// (`--all`) runs. Only the child types whose CC primaryIdentifier IS the CFn physical id
// (a bare ARN / UUID — the cross-stack class: SNS Subscription, ELBv2 Listener/Rule,
// EventBus Rule, Lambda ESM/Alias/Version, AppSync …) are resolvable; the composite-id
// children (`RestApiId|…`, `UserPoolId|…`) are within-stack API Gateway / Cognito
// sub-resources that this class never covers, so they are left alone (skipped by the `|`
// guard). Fails OPEN: any error (denied, throttled, or a physical id CFn does not accept)
// keeps the current behavior — the child is still reported as `added` rather than silently
// dropped. Results are memoized per physical id (added candidates are rare, but a shared
// parent can enumerate the same live child under multiple declared parents).
export async function isManagedBySiblingStack(
  cfn: CloudFormationClient,
  c: AddedChild,
  cache: Map<string, boolean>
): Promise<boolean> {
  const physicalId = c.identifier;
  // Pipe-composite CC identifiers (`RestApiId|…`, `UserPoolId|…`) are not CloudFormation
  // physical resource ids — they belong to within-stack API Gateway / Cognito sub-resources
  // outside this cross-stack class, so never spend a call on them. Bare ids that are ARNs
  // (SNS Subscription, ELBv2 Listener/Rule, EventBus Rule, Lambda Alias/Version) contain
  // `:` and ARE the class, so `:` is NOT a composite marker here; the lone `:`-joined
  // composite (API Gateway GatewayResponse `RestApiId:ResponseType`) simply fails the
  // DescribeStackResources lookup and falls through to "report as added" (fail open).
  if (physicalId.includes('|')) return false;
  const cached = cache.get(physicalId);
  if (cached !== undefined) return cached;
  let managed = false;
  try {
    const res = await cfn.send(
      new DescribeStackResourcesCommand({ PhysicalResourceId: physicalId })
    );
    // DescribeStackResources(PhysicalResourceId) returns every resource of the OWNING
    // stack; confirm the one matching this child's id + type is present (a stack owns it).
    managed = (res.StackResources ?? []).some(
      (r) => r.PhysicalResourceId === physicalId && r.ResourceType === c.resourceType
    );
  } catch {
    // No stack owns this physical id (ValidationError "does not exist") -> genuinely out of
    // band; or a permission/throttle error -> fail open to the current "report as added".
    managed = false;
  }
  cache.set(physicalId, managed);
  return managed;
}

interface ClassifyOpts {
  accountId: string;
  region: string;
  kmsAliasTargets: Record<string, string>;
  oaiCanonicalIds: Record<string, string>;
  siblingSgRules: Record<string, { ingress: unknown[]; egress: unknown[] }>;
  bucketNotificationManaged: Set<string>;
  clusterEchoModel: Record<string, Record<string, unknown>>;
}

// Rules declared by standalone AWS::EC2::SecurityGroupIngress / ::SecurityGroupEgress
// resources, keyed by the target SG's resolved GroupId (== the SG's physical id). CDK emits
// such a resource whenever a rule references a token it cannot inline (self/peer SG ref,
// prefix list, imported SG). The live SecurityGroup REFLECTS these rules in its own ingress/
// egress arrays, so classify subtracts them to avoid double-counting (see SG_RULE_REFLECTION
// in diff/classify.ts). Fail-open: a rule whose GroupId did not resolve to a concrete sg-id
// is skipped (the SG keeps the reflected rule -> a one-time visible FP, never a hidden change).
const SG_RULE_RESOURCE_SIDE: Record<string, 'ingress' | 'egress'> = {
  'AWS::EC2::SecurityGroupIngress': 'ingress',
  'AWS::EC2::SecurityGroupEgress': 'egress',
};
export function buildSiblingSgRules(
  desired: Desired
): Record<string, { ingress: unknown[]; egress: unknown[] }> {
  const map: Record<string, { ingress: unknown[]; egress: unknown[] }> = {};
  for (const r of desired.resources) {
    const side = SG_RULE_RESOURCE_SIDE[r.resourceType];
    if (!side) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const groupId = (decl as Record<string, unknown>).GroupId;
    if (typeof groupId !== 'string' || !groupId) continue; // unresolved intrinsic -> skip
    const rule = { ...(decl as Record<string, unknown>) };
    delete rule.GroupId;
    // A same-account SG-to-SG reference reads back a SourceSecurityGroupOwnerId AWS injects
    // (the account that owns the referenced SG) that the template never declares. Fill it in
    // with the stack's own account so (a) the classify subset-match still matches the live
    // reflected rule and (b) a revert's whole-array CC replacement re-sends the rule in its
    // EXACT live form — otherwise CC treats the owner-less rule as different and replaces it,
    // orphaning the sibling resource (observed live). A cross-account peer DECLARES the owner
    // id (CDK requires it), so it is already present and not overwritten.
    if (
      typeof rule.SourceSecurityGroupId === 'string' &&
      rule.SourceSecurityGroupOwnerId === undefined &&
      desired.accountId
    ) {
      rule.SourceSecurityGroupOwnerId = desired.accountId;
    }
    (map[groupId] ??= { ingress: [], egress: [] })[side].push(rule);
  }
  return map;
}

// Bucket physical ids (== bucket names) whose S3 notifications are managed by a
// Custom::S3BucketNotifications custom resource. CDK renders `bucket.addEventNotification()`
// / `enableEventBridgeNotification()` as this CR (which cdkrd cannot read/verify, so it is
// `skipped`), NOT as the bucket's own NotificationConfiguration property — so the live
// bucket REFLECTS the CR-applied config while its template resource declares nothing,
// surfacing the whole NotificationConfiguration as false undeclared drift on every such
// bucket. The config is IaC-managed (by the CR), not out of band; classify drops the
// reflected property for these buckets (see classifyResource). Fail-open: a CR whose
// BucketName did not resolve to a concrete name is skipped (the bucket keeps the reflected
// config -> a one-time visible FP, never a hidden change).
const S3_NOTIFICATIONS_CR_TYPE = 'Custom::S3BucketNotifications';
export function buildBucketNotificationManaged(desired: Desired): Set<string> {
  const byLogicalId = new Map<string, string>();
  for (const r of desired.resources) if (r.physicalId) byLogicalId.set(r.logicalId, r.physicalId);
  const managed = new Set<string>();
  for (const r of desired.resources) {
    if (r.resourceType !== S3_NOTIFICATIONS_CR_TYPE) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const bucketName = (decl as Record<string, unknown>).BucketName;
    if (typeof bucketName === 'string' && bucketName) {
      managed.add(bucketName); // already resolved to the concrete bucket name (== physical id)
    } else if (bucketName && typeof bucketName === 'object' && 'Ref' in bucketName) {
      const phys = byLogicalId.get((bucketName as { Ref: string }).Ref);
      if (phys) managed.add(phys);
    }
  }
  return managed;
}

// Per Aurora DBInstance physical id, the parent DBCluster's live model — the source for the
// CLUSTER_ECHO_CHILD strip in classify (an instance's undeclared property that echoes its
// cluster's cluster-level config). Resolved via the instance's declared DBClusterIdentifier
// (a Ref that resolves to the cluster's physical id). Fail-open: an instance whose parent
// cannot be resolved is simply not stripped (its echoes stay a one-time visible inventory,
// never a hidden change).
export function buildClusterEchoModels(desired: Desired): Record<string, Record<string, unknown>> {
  const clusterByPhys: Record<string, Record<string, unknown>> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::RDS::DBCluster' || !r.physicalId) continue;
    const live = desired.ctx.liveAttrs[r.logicalId];
    if (live && typeof live === 'object')
      clusterByPhys[r.physicalId] = live as Record<string, unknown>;
  }
  const map: Record<string, Record<string, unknown>> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::RDS::DBInstance' || !r.physicalId) continue;
    const clusterId = (r.declared as Record<string, unknown> | undefined)?.DBClusterIdentifier;
    if (typeof clusterId !== 'string') continue;
    const clusterLive = clusterByPhys[clusterId];
    if (clusterLive) map[r.physicalId] = clusterLive;
  }
  return map;
}

// CloudFront legacy OAI id -> S3CanonicalUserId, harvested from the stack's own
// OAI resources' live attributes (both are readOnly attrs the CC-API read already
// returned — no extra AWS call). Lets classify reconcile the two equivalent OAI
// principal forms in a resource policy (see rewriteOaiPrincipalsDeep). Empty when
// the stack declares no OAI.
const OAI_TYPE = 'AWS::CloudFront::CloudFrontOriginAccessIdentity';
function buildOaiCanonicalIds(desired: Desired): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== OAI_TYPE) continue;
    const live = desired.ctx.liveAttrs[r.logicalId];
    const id = live?.Id;
    const canonical = live?.S3CanonicalUserId;
    if (typeof id === 'string' && id && typeof canonical === 'string' && canonical) {
      map[id] = canonical;
    }
  }
  return map;
}

// Turn ONE resource's read into findings: no-physical-id / deleted / skipped
// short-circuits, else schema-strip + classify. Shared by gather's pass 2 and
// the scoped post-revert re-check (regatherTouched).
async function classifyRead(
  cfn: CloudFormationClient,
  r: DesiredResource,
  read: ReadResult | undefined,
  schemas: Map<string, SchemaInfo>,
  classifyOpts: ClassifyOpts
): Promise<Finding[]> {
  if (!r.physicalId) {
    return [
      {
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: 'no physical id',
      },
    ];
  }
  if (read?.deleted) {
    return [
      {
        tier: 'deleted',
        logicalId: r.logicalId,
        physicalId: r.physicalId,
        constructPath: r.constructPath,
        resourceType: r.resourceType,
        path: '',
        note: 'resource deleted out of band',
      },
    ];
  }
  if (!read || read.skippedReason || !read.live) {
    return [
      {
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: read?.skippedReason ?? 'not readable',
      },
    ];
  }
  const schema = schemas.get(r.resourceType) ?? (await getSchemaInfo(cfn, r.resourceType));
  schemas.set(r.resourceType, schema);
  return classifyResource(r, read.live, schema, classifyOpts);
}

export async function gatherFindings(
  stackName: string,
  region: string,
  // --pre-deploy: use the LOCAL synth template as the declared source instead of
  // the deployed template, so check reports the declared drift the next deploy
  // would overwrite. physIds + live reads still come from the deployed stack.
  templateOverride?: Record<string, unknown>,
  // the LOCAL synth template, passed through to loadDesired to recover GetTemplate's
  // `?`-masked non-ASCII literals (mask-gated). Distinct from templateOverride: it does
  // not replace the declared source, only patches corrupted leaves.
  recoveryTemplate?: Record<string, unknown>
): Promise<GatherResult> {
  const cfn = new CloudFormationClient({ region, ...READ_RETRY });
  const cc = new CloudControlClient({ region, ...READ_RETRY });

  const desired = await loadDesired(cfn, stackName, region, templateOverride, recoveryTemplate);
  const findings: Finding[] = [];
  const schemas = new Map<string, SchemaInfo>();

  // Pass 1: read every resource's live model first, so Fn::GetAtt in any
  // resource's declared props can be resolved against the referenced resource's
  // real attributes (populates ctx.liveAttrs) instead of falling to UNRESOLVED.
  // Pass-2 ordering stays deterministic (iterates desired.resources).
  const reads = new Map<string, ReadResult>();
  const targets = desired.resources.filter((r) => r.physicalId);
  await readAll(cc, targets, region, desired, reads);

  // Re-resolve EVERY resource's declared now that pass 1 populated all live
  // attributes, so Fn::GetAtt resolves. Hoisted out of pass 2 because pass 1.5
  // (below) needs the resolved declared. Mutated in place so downstream consumers
  // (revert / record) see the resolved view.
  for (const r of desired.resources) {
    if (r.declaredRaw) r.declared = resolveProperties(r.declaredRaw, desired.ctx);
  }

  // Pass 1.5: declared-dependent reads key off props that are frequently Fn::GetAtt
  // and so were UNRESOLVED during pass 1 (liveAttrs was still being filled) — the
  // resource is structurally readable, we just asked too early. Two shapes hit this:
  //   - SDK overrides whose target prop is a GetAtt (Lambda Permission.FunctionName =
  //     GetAtt[fn,Arn]) → pass 1 returned `skippedReason` ("target not resolvable").
  //   - CC composite-id types whose PARENT key is a GetAtt (ApiGatewayV2 Route.ApiId =
  //     GetAtt[Api,ApiId], ECS Service.Cluster = GetAtt[Cluster,Arn]): the composite
  //     identifier couldn't be built, so CC was queried with the BARE child id — which
  //     fails as `skippedReason` (ValidationException) OR, worse, `deleted`
  //     (ResourceNotFound) → a FALSE "deleted out of band". (Ref-sourced parents
  //     resolve in pass 1 via physIds, so only the GetAtt form is affected.)
  // Re-read ONCE, concurrently, both shapes when the earlier result was a skip OR a
  // deleted — now that liveAttrs is populated the parent resolves. A genuinely deleted
  // resource just reads not-found again, so re-reading the `deleted` set is safe.
  const retryTargets = desired.resources.filter((r) => {
    const prev = reads.get(r.logicalId);
    return (
      r.physicalId &&
      r.declaredRaw &&
      (SDK_OVERRIDES[r.resourceType] || CC_IDENTIFIER_ADAPTERS[r.resourceType]) &&
      (prev?.skippedReason || prev?.deleted)
    );
  });
  await readAll(cc, retryTargets, region, desired, reads);

  // Re-resolve once MORE when pass 1.5 actually read something: it populated liveAttrs
  // for the composite-id / SDK-override types it just read, so a CONSUMER whose declared
  // Fn::GetAtt targets one of those (e.g. a prop = GetAtt[<an ECS Service / Permission>,
  // attr]) was still UNRESOLVED after the first re-resolution above (which ran BEFORE
  // pass 1.5) — its property would be classified `unresolved` and skipped = a missed
  // drift. Monotonic and FP-safe: liveAttrs only grew, so this can only turn an
  // UNRESOLVED into a concrete value, never change an already-resolved one. Cheap:
  // retryTargets is empty for the common stack, so this loop is skipped entirely.
  if (retryTargets.length > 0) {
    for (const r of desired.resources) {
      if (r.declaredRaw) r.declared = resolveProperties(r.declaredRaw, desired.ctx);
    }
  }

  // OAI canonical-id map (CloudFront legacy OAI principal reconciliation) — harvested
  // from already-read liveAttrs, so it is ready before pass 1.6 normalizes added child
  // models AND reused for pass 2's classifyOpts below. Empty unless the stack declares
  // an OAI; for API Gateway children it is simply a no-op.
  const oaiCanonicalIds = buildOaiCanonicalIds(desired);

  // Pass 1.6: added-resource detection. For each declared PARENT type with a child
  // enumerator (read/child-enumerators.ts), list its live child resources and flag any
  // not in the template — a whole resource created out of band (e.g. an API Gateway
  // Method on `/`). The resource-granularity sibling of undeclared; not a per-property
  // compare, so it runs OUTSIDE classify. Each added child is then read in FULL (CC
  // GetResource) and normalized so `record` can snapshot it and a later change surfaces
  // as drift (PR4). An enumeration failure is a coverage gap, not drift — surfaced as a
  // `skipped` finding on the parent so it is never silently lost.
  const siblingStackCache = new Map<string, boolean>();
  for (const r of desired.resources) {
    const enumerate = CHILD_ENUMERATORS[r.resourceType];
    if (!enumerate || !r.physicalId) continue;
    // Only enumerate children of a parent we actually READ this run. The enumerators
    // match DECLARED children against the parent's live attributes (e.g. a Lambda
    // Function / EventBus matches its declared ESMs / Rules by the parent's `Arn`), and
    // those attrs are absent when the parent's own read failed transiently — Lambda
    // Function and Events::EventBus are in neither SDK_OVERRIDES nor
    // CC_IDENTIFIER_ADAPTERS, so pass 1.5 never retries them. With the parent unread,
    // every declared child would fail to match and false-flag as `added` — and `revert`
    // would then offer to DeleteResource a legitimately declared resource. The parent's
    // own skipped/deleted finding already carries that coverage gap, so skip enumeration.
    if (!reads.get(r.logicalId)?.live) continue;
    try {
      const children = await enumerate({ parent: r, desired, region });
      for (const c of children) {
        // A child CDK placed in a SIBLING stack of the same app (cross-stack refs, #666)
        // is fully CloudFormation-managed — not out of band. Skip it rather than false-flag
        // it as `added` (fails open on any resolve error -> still reported).
        if (await isManagedBySiblingStack(cfn, c, siblingStackCache)) continue;
        const read = await readAddedModel(cc, cfn, c, schemas, oaiCanonicalIds);
        findings.push(addedFinding(r, c, read));
      }
    } catch (e) {
      findings.push({
        tier: 'skipped',
        logicalId: r.logicalId,
        resourceType: r.resourceType,
        path: '',
        note: `added-resource scan: ${(e as Error).name}`,
      });
    }
  }

  // KMS managed-alias resolution (R9): only if the stack declares any `alias/aws/*`,
  // fetch alias -> target key id once so classify can tell a managed-default key from
  // a customer-managed key swapped in out of band. Missing kms:ListAliases -> empty +
  // denied (the classifier falls back to the conservative shape-based match) — and we
  // WARN once per region, because that fallback is BLIND to a customer-key swap (R115).
  let kmsAliasTargets: Record<string, string> = {};
  if (desired.resources.some((r) => usesManagedKmsAlias(r.declared))) {
    const resolved = await fetchManagedAliasTargets(region);
    kmsAliasTargets = resolved.targets;
    if (resolved.denied && !kmsDeniedWarned.has(region)) {
      kmsDeniedWarned.add(region);
      console.error(kmsListAliasesDeniedWarning(region));
    }
  }
  const classifyOpts = {
    accountId: desired.accountId,
    region,
    kmsAliasTargets,
    oaiCanonicalIds,
    siblingSgRules: buildSiblingSgRules(desired),
    bucketNotificationManaged: buildBucketNotificationManaged(desired),
    clusterEchoModel: buildClusterEchoModels(desired),
  };

  // Pass 2: classify (declared already re-resolved + override retries applied above).
  // CDKRD_CORPUS_DIR records every readable resource as a golden-corpus case
  // (the pure pipeline inputs + the findings they produced) for offline replay —
  // see src/corpus/record.ts (R63). Account ids are sanitized at record time.
  const corpusDir = process.env[CORPUS_DIR_ENV];
  for (const r of desired.resources) {
    const resourceFindings = await classifyRead(
      cfn,
      r,
      reads.get(r.logicalId),
      schemas,
      classifyOpts
    );
    findings.push(...resourceFindings);
    const live = reads.get(r.logicalId)?.live;
    const schema = schemas.get(r.resourceType);
    if (corpusDir && live && schema) {
      await recordCorpusCase(
        corpusDir,
        buildCorpusCase(r, live, schema, classifyOpts, resourceFindings)
      );
    }
  }
  return { desired, findings, schemas, liveByLogical: liveModelMap(reads) };
}

/**
 * Scoped re-gather for the post-revert convergence check (R44): re-read and
 * re-classify ONLY the `touched` resources, carrying every other resource's
 * findings forward from the original gather unchanged. The deployed template
 * cannot have changed (revert writes live state, not CloudFormation), so
 * `gathered.desired` and `gathered.schemas` stay valid — this turns a
 * whole-stack re-gather (template fetch + a live read per resource) into a
 * handful of reads, which is what made `revert` hang silently after the last
 * `reverted:` line. Out-of-band changes to UNTOUCHED resources during the
 * revert are deliberately not picked up — that is `check`'s job, and the old
 * full re-gather could even contradict the plan the user just confirmed by
 * blaming unrelated new drift on the revert.
 *
 * Returned findings are unordered across resources (untouched first, then the
 * fresh ones) — the convergence check only counts drift, it never renders them.
 * Mutates `gathered` the same way gatherFindings does (ctx.liveAttrs, resolved
 * declared, schemas cache).
 */
export async function regatherTouched(
  gathered: GatherResult,
  touched: Set<string>,
  region: string
): Promise<Finding[]> {
  const cfn = new CloudFormationClient({ region, ...READ_RETRY });
  const cc = new CloudControlClient({ region, ...READ_RETRY });
  const { desired, schemas } = gathered;
  const targets = desired.resources.filter((r) => touched.has(r.logicalId));

  const reads = new Map<string, ReadResult>();
  await readAll(
    cc,
    targets.filter((r) => r.physicalId),
    region,
    desired,
    reads
  );
  // Re-resolve declared against the refreshed liveAttrs (mirrors gather's hoisted
  // re-resolve) — GetAtt targets among the touched resources may have moved.
  for (const r of targets) {
    if (r.declaredRaw) r.declared = resolveProperties(r.declaredRaw, desired.ctx);
  }
  // Re-check path (revert convergence): reuse the cached targets; the denial warning,
  // if any, already fired in the primary gather, so just take the resolved map.
  const kmsAliasTargets = targets.some((r) => usesManagedKmsAlias(r.declared))
    ? (await fetchManagedAliasTargets(region)).targets
    : {};
  // Built from desired.ctx.liveAttrs (populated by the original gather), so the OAI
  // map is complete even though regather only re-reads the touched resources.
  const oaiCanonicalIds = buildOaiCanonicalIds(desired);
  const classifyOpts = {
    accountId: desired.accountId,
    region,
    kmsAliasTargets,
    oaiCanonicalIds,
    siblingSgRules: buildSiblingSgRules(desired),
    bucketNotificationManaged: buildBucketNotificationManaged(desired),
    clusterEchoModel: buildClusterEchoModels(desired),
  };

  const fresh: Finding[] = [];
  for (const r of targets) {
    fresh.push(...(await classifyRead(cfn, r, reads.get(r.logicalId), schemas, classifyOpts)));
  }
  // Refresh the live-model map for the re-read resources (so a follow-up tag-preserving
  // revert sees the post-revert managed-tag set), mirroring the findings carry-forward.
  for (const [logicalId, read] of reads)
    if (read.live) gathered.liveByLogical.set(logicalId, read.live);
  return [...gathered.findings.filter((f) => !touched.has(f.logicalId)), ...fresh];
}

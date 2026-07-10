// Shared read+classify pipeline used by both `check` and `record`.

import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { DescribeOptionGroupOptionsCommand, RDSClient } from '@aws-sdk/client-rds';
import { buildCorpusCase, CORPUS_DIR_ENV, recordCorpusCase } from '../corpus/record.js';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import { CLUSTER_ECHO_CHILD, classifyResource, normalizeLiveModel } from '../diff/classify.js';
import { resolveProperties } from '../normalize/intrinsic-resolver.js';
import { READ_RETRY } from '../read/client-config.js';
import {
  fetchManagedAliasTargets,
  kmsWarnDecision,
  typeNeedsManagedKeyResolution,
  usesManagedKmsAlias,
} from '../read/kms-aliases.js';
import { type AddedChild, CHILD_ENUMERATORS } from '../read/child-enumerators.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import { CC_IDENTIFIER_ADAPTERS, readLive, type ReadResult } from '../read/router.js';
import { getSchemaInfoResult } from '../schema/schema-strip.js';
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
// Regions already warned about a TRANSIENT kms:ListAliases failure (#963). A SEPARATE set
// from kmsDeniedWarned so a transient blip's dedupe never masks a later stack's GENUINE
// denial in the same region — the transient failure is not cached (kms-aliases.ts), so the
// next stack re-queries and a real denial then still surfaces.
const kmsTransientWarned = new Set<string>();

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
    // Reuse the per-run cache, else fetch. Only re-cache a SUCCESSFUL fetch: a DescribeType
    // failure returns an EMPTY schema (#751 — schema-strip itself does not cache it), and
    // caching that EMPTY in the per-run map would poison every later resource of this type
    // (writeOnly reinclude drops declared write-only props, createOnly bars lost) even after
    // the throttle clears — so leave the map unset on failure to let the next occurrence
    // re-fetch (#1067). The EMPTY still drives THIS resource's normalize (degraded, no strip).
    let schema = schemas.get(c.resourceType);
    if (!schema) {
      const res = await getSchemaInfoResult(cfn, c.resourceType);
      schema = res.info;
      if (!res.failed) schemas.set(c.resourceType, schema);
    }
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
// 'managed' = a CFn stack owns it (sibling-managed, not out of band); 'notManaged' = no stack
// owns it (genuinely out of band -> report as `added`); 'unverified' = the membership check
// itself FAILED (throttle / AccessDenied / network) OR could not reach the owning scope
// (a cross-account / cross-region CFn-managed child), so we CANNOT say either way (#754, #959).
export type SiblingCheck = 'managed' | 'notManaged' | 'unverified';

// The sibling-membership probe (DescribeStackResources) runs on the check's OWN CloudFormation
// client, scoped to the run's account+region. Its `ValidationError` ("Stack for <id> does not
// exist") therefore only proves the child is not in a stack of THIS account+region — NOT that it
// is unmanaged everywhere. A child fully CFn-managed by a stack in a DIFFERENT account or region
// (the canonical case: an SNS cross-account / cross-region `AWS::SNS::Subscription` fan-out — the
// subscription lives on the topic's account+region but is declared in the SUBSCRIBER's foreign
// stack) is invisible to that call and would be false-flagged `added` with a DESTRUCTIVE
// DeleteResource revert offer (#959). The child's physical id is an ARN carrying its own
// account+region, so parse it: only when the ARN's account AND region MATCH the check's scope is
// a `ValidationError` a DEFINITIVE not-managed (safe to report `added`); an ARN in a foreign
// account or region is UNVERIFIABLE — the owning stack is simply unreachable from here. Returns
// `true` (definitive) only for a same-account+region ARN (or an id we cannot parse as an ARN,
// which is inherently local — a bare name/UUID minted in this account+region). Returns `false`
// (unverifiable) for a foreign-scope ARN.
export function isDefinitiveNotManaged(
  physicalId: string,
  accountId: string,
  region: string
): boolean {
  // ARN form: arn:partition:service:region:account-id:resource — region at [3], account at [4].
  if (!physicalId.startsWith('arn:')) return true;
  const seg = physicalId.split(':');
  const arnRegion = seg[3] ?? '';
  const arnAccount = seg[4] ?? '';
  // Some ARNs omit region and/or account (empty segment) — those carry no foreign signal and are
  // treated as local (definitive). Only a NON-EMPTY segment that DIFFERS marks a foreign scope.
  if (arnRegion !== '' && arnRegion !== region) return false;
  if (arnAccount !== '' && arnAccount !== accountId) return false;
  return true;
}

export async function isManagedBySiblingStack(
  cfn: CloudFormationClient,
  c: AddedChild,
  cache: Map<string, SiblingCheck>,
  accountId: string,
  region: string
): Promise<SiblingCheck> {
  // The sibling-stack lookup uses the CloudFormation PHYSICAL-ID form, which for most child
  // types IS the CC primaryIdentifier (`identifier`); it diverges only where CC's identifier
  // is not the CFn physical id — e.g. AWS::Events::Rule, whose CC identifier is the rule Arn
  // but whose CFn physical id is `<busName>|<ruleName>` for a custom-bus rule (#895). The
  // enumerator carries that form on `siblingLookupId` (defaulting to `identifier`).
  const physicalId = c.siblingLookupId ?? c.identifier;
  // Pipe-composite CC identifiers (`RestApiId|…`, `UserPoolId|…`) are not CloudFormation
  // physical resource ids — they belong to within-stack API Gateway / Cognito sub-resources
  // outside this cross-stack class, so never spend a call on them. Bare ids that are ARNs
  // (SNS Subscription, ELBv2 Listener/Rule, EventBus Rule, Lambda Alias/Version) contain
  // `:` and ARE the class, so `:` is NOT a composite marker here; the lone `:`-joined
  // composite (API Gateway GatewayResponse `RestApiId:ResponseType`) simply fails the
  // DescribeStackResources lookup and falls through to "report as added" (fail open).
  // NOTE: an Events::Rule custom-bus `siblingLookupId` (`<busName>|<ruleName>`) IS a valid
  // CFn physical id despite the `|`; it is set explicitly so it is NOT a CC composite —
  // hence the `|` guard would wrongly skip it. The guard therefore only applies to the CC
  // `identifier` composites, which never set `siblingLookupId`, so it stays correct: a rule
  // whose lookup id contains `|` still runs the DescribeStackResources check below.
  if (c.siblingLookupId === undefined && physicalId.includes('|')) return 'notManaged';
  const cached = cache.get(physicalId);
  if (cached !== undefined) return cached;
  let managed = false;
  try {
    const res = await cfn.send(
      new DescribeStackResourcesCommand({ PhysicalResourceId: physicalId })
    );
    const owns = (
      rs: { PhysicalResourceId?: string | undefined; ResourceType?: string | undefined }[]
    ): boolean =>
      rs.some((r) => r.PhysicalResourceId === physicalId && r.ResourceType === c.resourceType);
    const first = res.StackResources ?? [];
    if (owns(first)) {
      managed = true;
    } else {
      // DescribeStackResources(PhysicalResourceId) returns ONLY the first 100 resources of the
      // owning stack and CANNOT paginate (#726). When the child is beyond that window in a big
      // sibling stack the match above misses and a fully CFn-managed child would be false-flagged
      // `added` (with a DeleteResource revert offer). Fall back to the PAGINATED
      // ListStackResources on the owning stack — its name comes from any resource Describe DID
      // return (they all belong to the one owning stack).
      const stackName = first[0]?.StackName;
      if (stackName) {
        let next: string | undefined;
        do {
          const page = await cfn.send(
            new ListStackResourcesCommand({ StackName: stackName, NextToken: next })
          );
          if (owns(page.StackResourceSummaries ?? [])) {
            managed = true;
            break;
          }
          next = page.NextToken;
        } while (next);
      }
    }
  } catch (e) {
    // Distinguish a GENUINE not-found from a FAILED / UNREACHABLE check (#754, #959).
    // CloudFormation answers DescribeStackResources for a physical id that belongs to no stack of
    // THIS account+region with a ValidationError ("Stack for <id> does not exist"). That is only a
    // definite "not managed" when the child's own scope IS this account+region — a child managed
    // by a stack in a DIFFERENT account/region is equally invisible to this scoped client and
    // yields the SAME ValidationError, so treating every ValidationError as `notManaged` would
    // false-flag a foreign-managed child `added` and offer a destructive DeleteResource on a
    // resource another stack legitimately owns (#959, the SNS cross-account/region fan-out). Parse
    // the physical-id ARN's account+region: only when it MATCHES the check's scope is this a
    // definitive, cacheable `notManaged` (a real out-of-band addition — still reported `added`);
    // a foreign-scope ARN is UNVERIFIABLE, so fall through to `unverified` (fail safe: reported as
    // coverage-incomplete, NEVER a destructive delete). Any OTHER error (Throttling under an --all
    // sweep, AccessDenied without cloudformation:DescribeStackResources, a network blip) is also
    // 'unverified' and NOT memoized (a transient throttle must not poison the run). The foreign-
    // scope determination IS deterministic per physical id, so caching it as 'notManaged' is not
    // done — we leave it un-cached like the other unverifiable cases for uniform handling.
    if (
      (e as { name?: string }).name === 'ValidationError' &&
      isDefinitiveNotManaged(physicalId, accountId, region)
    ) {
      cache.set(physicalId, 'notManaged');
      return 'notManaged';
    }
    return 'unverified';
  }
  const result: SiblingCheck = managed ? 'managed' : 'notManaged';
  cache.set(physicalId, result);
  return result;
}

interface ClassifyOpts {
  accountId: string;
  region: string;
  kmsAliasTargets: Record<string, string>;
  oaiCanonicalIds: Record<string, string>;
  siblingSgRules: Record<string, { ingress: unknown[]; egress: unknown[] }>;
  siblingEventBusPolicies: Record<string, unknown[]>;
  siblingManagedPolicyAttachments: Record<string, string[]>;
  siblingUserGroups: Record<string, string[]>;
  bucketNotificationManaged: Set<string>;
  clusterEchoModel: Record<string, Record<string, unknown>>;
  rdsOptionSettingDefaults: Record<string, Record<string, Record<string, string | null>>>;
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

// Statements declared by sibling AWS::Events::EventBusPolicy resources, keyed by their
// TARGET bus identifier (the resolved `EventBusName` == the bus's physical id; an absent /
// "default" name targets the default bus, keyed "default"). The live AWS::Events::EventBus
// REFLECTS these statements in an aggregated undeclared `Policy` = `{Version, Statement[]}`,
// so classify subtracts them (see subtractSiblingEventBusStatements in diff/classify.ts) to
// avoid a first-run FP + double-reporting — the sibling EventBusPolicy is tracked + compared
// as its own resource. Each sibling contributes ONE statement (its resolved `Statement`, a
// single statement object; CFn EventBusPolicy declares exactly one), stamped with its
// `StatementId` as the reflected `Sid` when the statement omits one. Fail-open: a policy whose
// target bus did not resolve to a concrete string is skipped (the bus keeps the reflected
// statement -> a one-time visible FP, never a hidden change). Any live statement that matches
// NO sibling (a purely out-of-band injection) is left to surface.
const EVENT_BUS_POLICY_TYPE = 'AWS::Events::EventBusPolicy';
const DEFAULT_EVENT_BUS = 'default';
export function buildSiblingEventBusPolicies(desired: Desired): Record<string, unknown[]> {
  const map: Record<string, unknown[]> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== EVENT_BUS_POLICY_TYPE) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    // An absent EventBusName (or the literal "default") targets the default event bus. A
    // custom bus is targeted by its resolved Name (== the bus's physical id). Skip an
    // unresolved intrinsic (fail-open — the bus keeps the reflected statement).
    const busName = d.EventBusName;
    let busKey: string;
    if (busName === undefined) busKey = DEFAULT_EVENT_BUS;
    else if (typeof busName === 'string' && busName) busKey = busName;
    else continue;
    // The single statement this policy declares (`Statement`), stamped with its `StatementId`
    // as the `Sid` AWS reflects when the statement itself omits one.
    const stmt = d.Statement;
    if (!stmt || typeof stmt !== 'object') continue;
    const statement = { ...(stmt as Record<string, unknown>) };
    if (statement.Sid === undefined && typeof d.StatementId === 'string' && d.StatementId) {
      statement.Sid = d.StatementId;
    }
    (map[busKey] ??= []).push(statement);
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

// A sibling AWS::IAM::ManagedPolicy declaring `Roles:[thisRole]` (/`Users`/`Groups`) attaches
// ITSELF to the principal; the principal's live read (a ListAttached*Policies UNION) then echoes
// that policy's ARN in its own `ManagedPolicyArns` — a value the principal never declared. Because
// a Role/User/Group DECLARES `ManagedPolicyArns` (or is compared as an ordinary array when it
// does), the sibling ARN reads as a DECLARED-tier drift that survives `record`, and a whole-array
// revert would DETACH the sibling-managed policy (destructive collateral, #698). The sibling
// ManagedPolicy is tracked + compared as its own resource, so classify subtracts its ARN from the
// principal's reflected live `ManagedPolicyArns` (see subtractSiblingManagedPolicyArns). Keyed by
// the principal identifier the classify finding uses (the principal's physical id == RoleName /
// UserName / GroupName; a sibling's `Roles`/`Users`/`Groups` entry is that same name, or a `Ref`
// that resolves to it). The attached value is the ManagedPolicy's physical id (== its ARN); if the
// policy has no resolved physical id, its `ManagedPolicyName` is used so a name-form live entry
// still matches. Fail-open: a principal reference that cannot be resolved, or a sibling policy with
// neither an ARN nor a name, is skipped (the principal keeps the reflected ARN → a one-time visible
// FP, never a hidden change); an out-of-band ARN matching NO sibling still surfaces.
const MANAGED_POLICY_TYPE = 'AWS::IAM::ManagedPolicy';
const MANAGED_POLICY_ATTACH_SIDES = ['Roles', 'Users', 'Groups'] as const;
export function buildSiblingManagedPolicyAttachments(desired: Desired): Record<string, string[]> {
  const byLogicalId = new Map<string, string>();
  for (const r of desired.resources) if (r.physicalId) byLogicalId.set(r.logicalId, r.physicalId);
  const map: Record<string, string[]> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== MANAGED_POLICY_TYPE) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    // The attached value the principal's live ManagedPolicyArns echoes: the policy's ARN (==
    // its physical id). Fall back to its declared ManagedPolicyName so a name-form live entry
    // matches; skip the policy entirely if neither is resolvable (fail-open).
    const attached =
      r.physicalId ??
      (typeof d.ManagedPolicyName === 'string' && d.ManagedPolicyName
        ? d.ManagedPolicyName
        : undefined);
    if (!attached) continue;
    for (const side of MANAGED_POLICY_ATTACH_SIDES) {
      const list = d[side];
      if (!Array.isArray(list)) continue;
      for (const principal of list) {
        const key = resolvePrincipalKey(principal, byLogicalId);
        if (key) (map[key] ??= []).push(attached);
      }
    }
  }
  return map;
}

// A sibling AWS::IAM::UserToGroupAddition (`Users:[thisUser], GroupName:g`) adds the user to a
// group; the user's live read echoes that group in an undeclared `Groups` list. The addition
// resource itself is a CC-gap `skipped` type (UnsupportedActionException), so the membership is
// verified nowhere and surfaces as a first-run undeclared FP on every such user (#698). Classify
// subtracts these sibling-declared groups from the user's live `Groups` (see
// subtractSiblingUserGroups), leaving any out-of-band group (matching no sibling) to still surface.
// Keyed by the user identifier the classify finding uses (the user's physical id == UserName; a
// `Users` entry is that name or a `Ref` resolving to it). The group value is the addition's
// resolved `GroupName` (== the group's physical id, which the live `Groups` echoes), or a `Ref`
// resolved via the logical-id map. Fail-open: an unresolved user or group reference is skipped.
const USER_TO_GROUP_TYPE = 'AWS::IAM::UserToGroupAddition';
export function buildSiblingUserGroups(desired: Desired): Record<string, string[]> {
  const byLogicalId = new Map<string, string>();
  for (const r of desired.resources) if (r.physicalId) byLogicalId.set(r.logicalId, r.physicalId);
  const map: Record<string, string[]> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== USER_TO_GROUP_TYPE) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    const group = resolvePrincipalKey(d.GroupName, byLogicalId);
    if (!group) continue; // unresolved group name -> fail-open (the user keeps the reflected group)
    const users = d.Users;
    if (!Array.isArray(users)) continue;
    for (const user of users) {
      const key = resolvePrincipalKey(user, byLogicalId);
      if (key) (map[key] ??= []).push(group);
    }
  }
  return map;
}

// A standalone AWS::AutoScaling::LifecycleHook (`AutoScalingGroupName: <asg>`) attaches a hook to an
// ASG; that hook then appears in the ASG's live `LifecycleHookSpecificationList` — origin-
// indistinguishable from a hook the ASG declared INLINE. So a stack that mixes an inline
// `LifecycleHookSpecificationList` with a standalone `CfnLifecycleHook` produces a DECLARED-tier FP
// that survives `record` (the declared inline list never equals the inline+standalone live list),
// and a standalone-ONLY ASG additionally FPs the whole list as UNDECLARED (#700). The standalone
// hook is tracked + compared as its OWN resource, so classify subtracts sibling-declared hooks from
// the ASG's live list BY NAME (see subtractSiblingLifecycleHooks) — leaving the inline-declared
// hooks (and any out-of-band hook, matching no sibling) to compare. Keyed by the target ASG
// identifier the classify finding uses (the ASG's physical id == AutoScalingGroupName; a
// `{Ref: <asgLogicalId>}` resolves via the logical-id map). The hook NAME the live list echoes is
// the LifecycleHook's physical id (== its name); fall back to a declared `LifecycleHookName`. Fail-
// open: an unresolved ASG reference or a nameless hook is skipped (the ASG keeps the reflected hook
// -> a one-time visible FP, never a hidden change).
const LIFECYCLE_HOOK_TYPE = 'AWS::AutoScaling::LifecycleHook';
export function buildSiblingLifecycleHooks(desired: Desired): Record<string, string[]> {
  const byLogicalId = new Map<string, string>();
  for (const r of desired.resources) if (r.physicalId) byLogicalId.set(r.logicalId, r.physicalId);
  const map: Record<string, string[]> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== LIFECYCLE_HOOK_TYPE) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    const asgKey = resolvePrincipalKey(d.AutoScalingGroupName, byLogicalId);
    if (!asgKey) continue; // unresolved ASG reference -> fail-open
    const name =
      r.physicalId ??
      (typeof d.LifecycleHookName === 'string' && d.LifecycleHookName
        ? d.LifecycleHookName
        : undefined);
    if (!name) continue;
    (map[asgKey] ??= []).push(name);
  }
  return map;
}

// Resolve an IAM principal/group reference to the concrete identity the live read echoes: a plain
// string is the resolved name (== physical id); a `{Ref: logicalId}` resolves via the logical-id ->
// physical-id map. Any other shape (an unresolved intrinsic) yields undefined -> the caller skips
// it (fail-open).
function resolvePrincipalKey(ref: unknown, byLogicalId: Map<string, string>): string | undefined {
  if (typeof ref === 'string' && ref) return ref;
  if (ref && typeof ref === 'object' && 'Ref' in ref) {
    const logicalId = (ref as { Ref: unknown }).Ref;
    if (typeof logicalId === 'string') return byLogicalId.get(logicalId);
  }
  return undefined;
}

// Per Aurora DBInstance physical id, the parent DBCluster's live model — the source for the
// CLUSTER_ECHO_CHILD strip in classify (an instance's undeclared property that echoes its
// cluster's cluster-level config). Resolved via the instance's declared DBClusterIdentifier
// (a Ref that resolves to the cluster's physical id). Fail-open: an instance whose parent
// cannot be resolved is simply not stripped (its echoes stay a one-time visible inventory,
// never a hidden change).
export function buildClusterEchoModels(desired: Desired): Record<string, Record<string, unknown>> {
  // Both the parent cluster types to harvest and the child types to resolve are sourced from
  // CLUSTER_ECHO_CHILD — the SAME table the classify strip reads — so a new echo-child entry
  // wires this live path automatically (a hardcoded RDS-only list here silently left Neptune's
  // fold corpus-green but live-broken, #980). A child's parentIdKey Refs its parent's physical id;
  // physical ids are unique across types, so one clusterByPhys map serves all parent types.
  const parentTypes = new Set(Object.values(CLUSTER_ECHO_CHILD).map((s) => s.parentType));
  const clusterByPhys: Record<string, Record<string, unknown>> = {};
  for (const r of desired.resources) {
    if (!parentTypes.has(r.resourceType) || !r.physicalId) continue;
    const live = desired.ctx.liveAttrs[r.logicalId];
    if (live && typeof live === 'object')
      clusterByPhys[r.physicalId] = live as Record<string, unknown>;
  }
  const map: Record<string, Record<string, unknown>> = {};
  for (const r of desired.resources) {
    const spec = CLUSTER_ECHO_CHILD[r.resourceType];
    if (!spec || !r.physicalId) continue;
    const clusterId = (r.declared as Record<string, unknown> | undefined)?.[spec.parentIdKey];
    if (typeof clusterId !== 'string') continue;
    const clusterLive = clusterByPhys[clusterId];
    if (clusterLive) map[r.physicalId] = clusterLive;
  }
  return map;
}

// #978: resolve each AWS::RDS::OptionGroup's option-default catalog from
// `describe-option-group-options` (per engine+version, cached and paginated), keyed
// `physicalId -> optionName -> settingName -> DefaultValue|null`. classify folds a live-only
// setting whose value equals its catalog default (or an unset `{Name}` husk) to atDefault, so a
// clean OptionGroup shows zero first-run drift while an out-of-band change still surfaces. The
// catalog is read LIVE (never pinned) so it cannot rot (#1072) and needs no per-plugin constant
// table. Fail-soft: a denied/failed describe warns ONCE and leaves that group out of the map — its
// value-bearing defaults then surface undeclared (the pre-#978 behavior), never a crash.
export async function buildRdsOptionSettingDefaults(
  desired: Desired,
  region: string
): Promise<Record<string, Record<string, Record<string, string | null>>>> {
  const groups = desired.resources.filter(
    (r) => r.resourceType === 'AWS::RDS::OptionGroup' && r.physicalId
  );
  if (groups.length === 0) return {};
  const client = new RDSClient({ region, ...READ_RETRY });
  const catalogCache = new Map<string, Record<string, Record<string, string | null>>>();
  const out: Record<string, Record<string, Record<string, string | null>>> = {};
  let warned = false;
  for (const r of groups) {
    const decl = r.declared as { EngineName?: unknown; MajorEngineVersion?: unknown } | undefined;
    const engine = typeof decl?.EngineName === 'string' ? decl.EngineName : undefined;
    const version = decl?.MajorEngineVersion != null ? String(decl.MajorEngineVersion) : undefined;
    if (!engine || !version || !r.physicalId) continue;
    const key = `${engine}:${version}`;
    let catalog = catalogCache.get(key);
    if (!catalog) {
      try {
        catalog = await fetchOptionCatalog(client, engine, version);
        catalogCache.set(key, catalog);
      } catch (e) {
        if (!warned) {
          console.error(
            `warning: describe-option-group-options failed for ${engine} ${version} (${(e as Error).name}) — RDS OptionGroup default-fill settings may surface as first-run drift; grant rds:DescribeOptionGroupOptions`
          );
          warned = true;
        }
        continue;
      }
    }
    out[r.physicalId] = catalog;
  }
  return out;
}

async function fetchOptionCatalog(
  client: RDSClient,
  engineName: string,
  majorEngineVersion: string
): Promise<Record<string, Record<string, string | null>>> {
  const catalog: Record<string, Record<string, string | null>> = {};
  let marker: string | undefined;
  do {
    const resp = await client.send(
      new DescribeOptionGroupOptionsCommand({
        EngineName: engineName,
        MajorEngineVersion: majorEngineVersion,
        Marker: marker,
      })
    );
    for (const opt of resp.OptionGroupOptions ?? []) {
      if (!opt.Name) continue;
      const settings: Record<string, string | null> = catalog[opt.Name] ?? {};
      for (const s of opt.OptionGroupOptionSettings ?? []) {
        if (s.SettingName) settings[s.SettingName] = s.DefaultValue ?? null;
      }
      catalog[opt.Name] = settings;
    }
    marker = resp.Marker;
  } while (marker);
  return catalog;
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
  // Reuse the per-run cache, else fetch. A DescribeType FAILURE returns an EMPTY schema
  // (#751) that must NOT be re-cached in the per-run map — caching it would keep every later
  // resource of this type on the degraded EMPTY (no readOnly strip → first-run noise; no
  // writeOnly readGap → false declared drift; and it poisons revert: writeOnlyReincludeOps
  // drops declared write-only props, createOnly bars lost) even after the throttle clears
  // (#1067). Leave the map unset on failure so the next resource of the type re-fetches.
  //
  // Beyond not caching it, we must NOT diff THIS resource against the EMPTY schema either
  // (#858): an un-schema'd compare is wrong in BOTH directions — readOnly live attrs (Arn,
  // ids, timestamps) are not stripped → flood `[Potential Drift]` (first-run-noise invariant
  // violated); declared writeOnly props are not routed to readGap → compared against an absent
  // live value → red `[CFn-Declared Drift]` (`--fail` exits 1 on an untouched stack). Surfacing
  // a known-wrong diff is worse than admitting the coverage gap, so DEGRADE to a single `skipped`
  // finding (coverage-incomplete, `--strict`-visible) — mirroring the not-readable branch above.
  // Only when the schema was FETCHED THIS CALL and FAILED: a cache HIT is a prior SUCCESS (a real
  // schema), so classify normally. Key off `res.failed`, not `schema` being empty.
  const cachedSchema = schemas.get(r.resourceType);
  if (!cachedSchema) {
    const res = await getSchemaInfoResult(cfn, r.resourceType);
    if (res.failed) {
      return [
        {
          tier: 'skipped',
          logicalId: r.logicalId,
          resourceType: r.resourceType,
          path: '',
          note: 'schema unavailable (DescribeType failed) — coverage incomplete',
        },
      ];
    }
    schemas.set(r.resourceType, res.info);
    return classifyResource(r, read.live, res.info, {
      ...classifyOpts,
      supplementReadGapPaths: read.readGapPaths,
    });
  }
  return classifyResource(r, read.live, cachedSchema, {
    ...classifyOpts,
    supplementReadGapPaths: read.readGapPaths,
  });
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
  const siblingStackCache = new Map<string, SiblingCheck>();
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
        // is fully CloudFormation-managed — not out of band, so skip it.
        const sibling = await isManagedBySiblingStack(
          cfn,
          c,
          siblingStackCache,
          desired.accountId,
          region
        );
        if (sibling === 'managed') continue;
        if (sibling === 'unverified') {
          // The sibling-membership check FAILED (throttle / denied), so we cannot say whether this
          // child is CFn-managed. Do NOT report it as `added` — a false `added` would offer a
          // destructive Cloud Control DeleteResource on a possibly sibling-managed resource (#754).
          // Surface it as coverage-incomplete instead, so the gap is visible but never destructive.
          findings.push({
            tier: 'skipped',
            logicalId: r.logicalId,
            resourceType: r.resourceType,
            path: '',
            note: `sibling-stack membership unverifiable for ${c.label} (${c.resourceType})`,
          });
          continue;
        }
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
  // The type check also fires for resource types whose UNDECLARED managed-key path
  // (e.g. DynamoDB SSESpecification.KMSMasterKeyId, OpenSearch EncryptionAtRestOptions.KmsKeyId)
  // must be gated against the AWS-managed key ARN even when the template declares no
  // `alias/aws/*` — otherwise classify's managed-key gate always fails open and an
  // out-of-band CMK swap stays invisible (#704).
  let kmsAliasTargets: Record<string, string> = {};
  if (
    desired.resources.some(
      (r) => usesManagedKmsAlias(r.declared) || typeNeedsManagedKeyResolution(r.resourceType)
    )
  ) {
    const resolved = await fetchManagedAliasTargets(region);
    kmsAliasTargets = resolved.targets;
    // A denied read is either a genuine IAM denial (permanent — grant kms:ListAliases) or
    // a TRANSIENT blip (throttle/network/5xx; no action needed, retried next stack). Emit
    // the RIGHT message and stamp the RIGHT dedupe set — a transient blip must NOT poison
    // kmsDeniedWarned, or a later stack's real denial in this region would go unexplained (#963).
    const decision = kmsWarnDecision(
      region,
      resolved,
      kmsDeniedWarned.has(region),
      kmsTransientWarned.has(region)
    );
    if (decision.stampDenied) kmsDeniedWarned.add(region);
    if (decision.stampTransient) kmsTransientWarned.add(region);
    if (decision.warning) console.error(decision.warning);
  }
  const classifyOpts = {
    accountId: desired.accountId,
    region,
    kmsAliasTargets,
    oaiCanonicalIds,
    siblingSgRules: buildSiblingSgRules(desired),
    siblingEventBusPolicies: buildSiblingEventBusPolicies(desired),
    siblingManagedPolicyAttachments: buildSiblingManagedPolicyAttachments(desired),
    siblingUserGroups: buildSiblingUserGroups(desired),
    siblingLifecycleHooks: buildSiblingLifecycleHooks(desired),
    bucketNotificationManaged: buildBucketNotificationManaged(desired),
    clusterEchoModel: buildClusterEchoModels(desired),
    rdsOptionSettingDefaults: await buildRdsOptionSettingDefaults(desired, region),
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
  const kmsAliasTargets = targets.some(
    (r) => usesManagedKmsAlias(r.declared) || typeNeedsManagedKeyResolution(r.resourceType)
  )
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
    siblingEventBusPolicies: buildSiblingEventBusPolicies(desired),
    siblingManagedPolicyAttachments: buildSiblingManagedPolicyAttachments(desired),
    siblingUserGroups: buildSiblingUserGroups(desired),
    siblingLifecycleHooks: buildSiblingLifecycleHooks(desired),
    bucketNotificationManaged: buildBucketNotificationManaged(desired),
    clusterEchoModel: buildClusterEchoModels(desired),
    rdsOptionSettingDefaults: await buildRdsOptionSettingDefaults(desired, region),
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

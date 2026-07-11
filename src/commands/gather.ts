// Shared read+classify pipeline used by both `check` and `record`.

import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  EC2Client,
  GetDefaultCreditSpecificationCommand,
  GetEbsEncryptionByDefaultCommand,
  GetInstanceMetadataDefaultsCommand,
  type UnlimitedSupportedInstanceFamily,
} from '@aws-sdk/client-ec2';
import { ECSClient, ListAccountSettingsCommand } from '@aws-sdk/client-ecs';
import {
  DescribeCertificatesCommand,
  DescribeOptionGroupOptionsCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { GetServiceSettingCommand, SSMClient } from '@aws-sdk/client-ssm';
import { buildCorpusCase, CORPUS_DIR_ENV, recordCorpusCase } from '../corpus/record.js';
import { type Desired, loadDesired } from '../desired/template-adapter.js';
import {
  AAS_SCALABLE_DIMENSIONS,
  type AccountDefaults,
  CLUSTER_ECHO_CHILD,
  classifyResource,
  normalizeLiveModel,
} from '../diff/classify.js';
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

// #889: resource types whose UNDECLARED default security-group list (ALB SecurityGroups / ENI
// GroupSet) is gated in classify against the VPC-default SG ids — mirror of
// typeNeedsManagedKeyResolution. When a stack declares one, prefetch the account/region default
// SGs so the classifier can DERIVE-gate the fold (single default SG folds; an append/swap surfaces).
const DEFAULT_SG_LIST_TYPES: ReadonlySet<string> = new Set([
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::EC2::NetworkInterface',
  // #976: Neptune DBCluster's undeclared VpcSecurityGroupIds default is the VPC default SG —
  // gated in classify against the prefetched default-SG ids so an OOB swap/append surfaces.
  'AWS::Neptune::DBCluster',
  // #1266: AmazonMQ Broker's undeclared SecurityGroups default is the VPC default SG — same gate,
  // so the prefetch must fire when a broker is present too.
  'AWS::AmazonMQ::Broker',
  // #1269: RedshiftServerless Workgroup's undeclared SecurityGroupIds default is the default-VPC SG
  // — same gate, so the prefetch must fire when a workgroup is present too.
  'AWS::RedshiftServerless::Workgroup',
]);

// #1269: types whose undeclared SubnetIds default to ALL of the account's DEFAULT-VPC subnets —
// gated in classify against the prefetched default-VPC subnet ids so an OOB re-placement into a
// non-default subnet surfaces. Distinct from DEFAULT_SG_LIST_TYPES (that is a single-SG gate).
const DEFAULT_SUBNET_LIST_TYPES: ReadonlySet<string> = new Set([
  'AWS::RedshiftServerless::Workgroup',
]);

// #889: fetch the account/region VPC-default security-group ids — one `DescribeSecurityGroups`
// filtered by group-name=default returns exactly one default SG per VPC. Mirrors the
// fetchManagedAliasTargets prefetch pattern: cached per region, FAIL OPEN (return an empty set on
// ANY error — missing ec2:DescribeSecurityGroups, throttle, network) so classify keeps folding the
// undeclared SG list and a clean deploy never gains a first-run false positive. The derived
// swap/append detection is therefore best-effort and requires ec2:DescribeSecurityGroups.
const defaultSgIdsCache = new Map<string, Set<string>>();
async function fetchDefaultSgIds(region: string): Promise<Set<string>> {
  const cached = defaultSgIdsCache.get(region);
  if (cached) return cached;
  const ids = new Set<string>();
  try {
    const c = new EC2Client({ region, ...READ_RETRY });
    let token: string | undefined;
    do {
      const r = await c.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: 'group-name', Values: ['default'] }],
          NextToken: token,
          MaxResults: 1000,
        })
      );
      for (const g of r.SecurityGroups ?? []) if (g.GroupId) ids.add(g.GroupId);
      token = r.NextToken;
    } while (token);
  } catch {
    // Fail open: leave the set empty so classify keeps folding (no new first-run false positive).
    // Not cached on error, so the next stack in the region retries (mirrors the transient path).
    return ids;
  }
  defaultSgIdsCache.set(region, ids);
  return ids;
}

// #1269: fetch the account/region DEFAULT-VPC subnet ids — one `DescribeSubnets` filtered by
// `default-for-az=true` returns exactly the default VPC's subnets (one per AZ; a default VPC's
// subnets ARE its default-for-az subnets). Mirrors fetchDefaultSgIds: cached per region, FAIL OPEN
// (empty set on ANY error — missing ec2:DescribeSubnets, throttle, network) so classify keeps
// folding the undeclared subnet list and a clean deploy never gains a first-run false positive.
const defaultSubnetIdsCache = new Map<string, Set<string>>();
async function fetchDefaultVpcSubnetIds(region: string): Promise<Set<string>> {
  const cached = defaultSubnetIdsCache.get(region);
  if (cached) return cached;
  const ids = new Set<string>();
  try {
    const c = new EC2Client({ region, ...READ_RETRY });
    let token: string | undefined;
    do {
      const r = await c.send(
        new DescribeSubnetsCommand({
          Filters: [{ Name: 'default-for-az', Values: ['true'] }],
          NextToken: token,
          MaxResults: 1000,
        })
      );
      for (const s of r.Subnets ?? []) if (s.SubnetId) ids.add(s.SubnetId);
      token = r.NextToken;
    } while (token);
  } catch {
    // Fail open: leave the set empty so classify keeps folding (no new first-run false positive).
    // Not cached on error, so the next stack in the region retries (mirrors the transient path).
    return ids;
  }
  defaultSubnetIdsCache.set(region, ids);
  return ids;
}

// #1070: the effective account/region default settings a few undeclared defaults derive from — each
// is an account-level control the owner can change (a documented hardening best practice), so a
// fixed KNOWN_DEFAULTS pin FPs on every fresh deploy in an account that adopted it. Each lookup is
// ONE read-only call, cached per region, and FAILS OPEN (returns undefined on any error — denied
// permission, throttle, network — WITHOUT caching, so the next stack retries) so classify falls back
// to the factory-default constant and a clean deploy never gains a first-run false positive. The
// derived out-of-band change detection is therefore best-effort and requires the read permission.

// ecs:ListAccountSettings effective `containerInsights` — AWS::ECS::Cluster.ClusterSettings default.
const ecsContainerInsightsCache = new Map<string, string | undefined>();
async function fetchEcsContainerInsightsDefault(region: string): Promise<string | undefined> {
  if (ecsContainerInsightsCache.has(region)) return ecsContainerInsightsCache.get(region);
  try {
    const c = new ECSClient({ region, ...READ_RETRY });
    const r = await c.send(
      new ListAccountSettingsCommand({ name: 'containerInsights', effectiveSettings: true })
    );
    const value = r.settings?.find((s) => s.name === 'containerInsights')?.value;
    ecsContainerInsightsCache.set(region, value);
    return value;
  } catch {
    return undefined;
  }
}

// ssm:GetServiceSetting `/ssm/parameter-store/default-parameter-tier` — AWS::SSM::Parameter.Tier default.
const ssmParameterTierCache = new Map<string, string | undefined>();
async function fetchSsmDefaultParameterTier(region: string): Promise<string | undefined> {
  if (ssmParameterTierCache.has(region)) return ssmParameterTierCache.get(region);
  try {
    const c = new SSMClient({ region, ...READ_RETRY });
    const r = await c.send(
      new GetServiceSettingCommand({ SettingId: '/ssm/parameter-store/default-parameter-tier' })
    );
    const value = r.ServiceSetting?.SettingValue;
    ssmParameterTierCache.set(region, value);
    return value;
  } catch {
    return undefined;
  }
}

// ec2:GetEbsEncryptionByDefault — AWS::EC2::Volume.Encrypted reads back `true` undeclared when on.
const ebsEncryptionByDefaultCache = new Map<string, boolean | undefined>();
async function fetchEbsEncryptionByDefault(region: string): Promise<boolean | undefined> {
  if (ebsEncryptionByDefaultCache.has(region)) return ebsEncryptionByDefaultCache.get(region);
  try {
    const c = new EC2Client({ region, ...READ_RETRY });
    const r = await c.send(new GetEbsEncryptionByDefaultCommand({}));
    const value = r.EbsEncryptionByDefault;
    ebsEncryptionByDefaultCache.set(region, value);
    return value;
  } catch {
    return undefined;
  }
}

// #1070 item 4: ec2:GetDefaultCreditSpecification per burstable family — the account-effective
// default CpuCredits ('standard'|'unlimited') an EC2::Instance of that family reads back when it
// declares no CreditSpecification. Cached per (region, family), fail-open (undefined, not cached).
const ec2CreditDefaultCache = new Map<string, string | undefined>();
async function fetchEc2FamilyCreditDefault(
  region: string,
  family: string
): Promise<string | undefined> {
  const cacheKey = `${region}|${family}`;
  if (ec2CreditDefaultCache.has(cacheKey)) return ec2CreditDefaultCache.get(cacheKey);
  try {
    const c = new EC2Client({ region, ...READ_RETRY });
    // `family` is regex-gated to a `t<digit>` burstable prefix; an unsupported value simply throws
    // at the API and is caught below (fail-open). The SDK types InstanceFamily as a closed union.
    const r = await c.send(
      new GetDefaultCreditSpecificationCommand({
        InstanceFamily: family as UnlimitedSupportedInstanceFamily,
      })
    );
    const value = r.InstanceFamilyCreditSpecification?.CpuCredits;
    ec2CreditDefaultCache.set(cacheKey, value);
    return value;
  } catch {
    return undefined;
  }
}

// #1070 item 5: rds:DescribeCertificates — the account's CUSTOMER-OVERRIDE default CA identifier
// (the cert with `CustomerOverride=true`), which every new RDS/DocDB DBInstance that declares no
// CACertificateIdentifier reads back. Undefined when no override is set (the account uses AWS's
// system default) → classify falls back to the KNOWN_DEFAULTS constant. Cached per region, fail-open.
const rdsDefaultCaCache = new Map<string, string | undefined>();
async function fetchRdsDefaultCaIdentifier(region: string): Promise<string | undefined> {
  if (rdsDefaultCaCache.has(region)) return rdsDefaultCaCache.get(region);
  try {
    const c = new RDSClient({ region, ...READ_RETRY });
    const r = await c.send(new DescribeCertificatesCommand({}));
    const override = (r.Certificates ?? []).find((cert) => cert.CustomerOverride === true);
    const value = override?.CertificateIdentifier;
    rdsDefaultCaCache.set(region, value);
    return value;
  } catch {
    return undefined;
  }
}

// #1070 item 3: ec2:GetInstanceMetadataDefaults — the account-level IMDS defaults the owner set
// (`ec2:modify-instance-metadata-defaults`). Returns only the SET fields among HttpTokens /
// HttpPutResponseHopLimit / HttpEndpoint / InstanceMetadataTags (unset ones are absent / null);
// `ManagedBy` is metadata, not a MetadataOptions field, so it is dropped. classify overlays these
// onto the AL2023 MetadataOptions constant for an EC2::Instance that declares no MetadataOptions.
// Undefined when nothing is set at account level → the constant stands. Cached per region, fail-open.
const instanceMetadataDefaultsCache = new Map<
  string,
  Record<string, string | number> | undefined
>();
async function fetchInstanceMetadataDefaults(
  region: string
): Promise<Record<string, string | number> | undefined> {
  if (instanceMetadataDefaultsCache.has(region)) return instanceMetadataDefaultsCache.get(region);
  try {
    const c = new EC2Client({ region, ...READ_RETRY });
    const r = await c.send(new GetInstanceMetadataDefaultsCommand({}));
    const al = r.AccountLevel;
    const out: Record<string, string | number> = {};
    if (al?.HttpTokens != null) out.HttpTokens = al.HttpTokens;
    if (al?.HttpPutResponseHopLimit != null)
      out.HttpPutResponseHopLimit = al.HttpPutResponseHopLimit;
    if (al?.HttpEndpoint != null) out.HttpEndpoint = al.HttpEndpoint;
    if (al?.InstanceMetadataTags != null) out.InstanceMetadataTags = al.InstanceMetadataTags;
    const value = Object.keys(out).length > 0 ? out : undefined;
    instanceMetadataDefaultsCache.set(region, value);
    return value;
  } catch {
    return undefined;
  }
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
export function addedFinding(
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

// Added types whose Cloud Control GetResource is DOOMED — NON_PROVISIONABLE in the CC
// registry, so `GetResource` throws `UnsupportedActionException` on every run (#1431). For
// these the model read below would always fail, flag the finding `modelReadFailed`, and
// `record`/`ignore` could never endorse the resource — it re-surfaced as `added` on every
// `check` with no way to accept it. But the child ENUMERATOR already carries the full,
// recordable model in its `live` snippet (a Route53 RecordSet's Name/Type/TTL/ResourceRecords/
// AliasTarget), so use THAT as the recordable model instead of the doomed CC read. (Its real
// delete goes through a type-specific SDK deleter, not CC — see revert/writers.ts SDK_DELETERS.)
// AWS::SQS::QueuePolicy (#835): the CC primaryIdentifier is a service-generated `Id`, which
// an out-of-band `set-queue-attributes Policy=…` never produces — so a CC GetResource keyed on
// the queue URL the enumerator carries would always fail. The enumerator's `live` snippet
// ({ Queues, PolicyDocument }) IS the recordable model; use it. (Its real delete goes through
// the `deleteSqsQueuePolicy` SDK deleter — SetQueueAttributes with an empty Policy — not CC.)
// AWS::SecretsManager::ResourcePolicy (#835): same generated-`Id` primaryIdentifier situation as
// AWS::SQS::QueuePolicy — an out-of-band `put-resource-policy` produces no CFn `Id`, so a CC
// GetResource keyed on the secret ARN the enumerator carries would fail. The enumerator's `live`
// snippet ({ SecretId, ResourcePolicy }) IS the recordable model; use it. (Its real delete goes
// through the `deleteSecretsManagerResourcePolicy` SDK deleter — DeleteResourcePolicy — not CC.)
// AWS::SNS::TopicPolicy (#835): same generated-`Id` primaryIdentifier situation — an out-of-band
// `set-topic-attributes Policy=…` produces no CFn `Id`, so a CC GetResource keyed on the topic ARN
// the enumerator carries would fail. The enumerator's `live` snippet ({ Topics, PolicyDocument }) IS
// the recordable model; use it. (Its real delete goes through the `deleteSnsTopicPolicy` SDK deleter
// — SetTopicAttributes back to the AWS-default policy — not CC.)
// AWS::KMS::Grant (#835): a SYNTHETIC type — a KMS grant is not a CloudFormation / Cloud Control
// resource at all, so CC GetResource / DescribeType cannot know it. The child enumerator's `live`
// snippet ({ GrantId, GranteePrincipal, Operations, … }) IS the recordable model; use it. (Its real
// delete goes through the `deleteKmsGrant` SDK deleter — RevokeGrant keyed on the parent key +
// GrantId — not CC.)
const CC_GET_UNSUPPORTED_ADDED_TYPES = new Set<string>([
  'AWS::Route53::RecordSet',
  'AWS::SQS::QueuePolicy',
  'AWS::SecretsManager::ResourcePolicy',
  'AWS::SNS::TopicPolicy',
  'AWS::KMS::Grant',
]);

// Read the added child's FULL live model via Cloud Control GetResource (its
// `identifier` is the CC composite, the same one revert's DeleteResource consumes) and
// normalize it for record/compare. On any read/parse error return the enumerator's
// identity-only `live` snippet with `ok: false` — the resource is still REPORTED as
// added, but the finding is flagged `modelReadFailed` so record skips snapshotting the
// partial model and applyBaseline never false-flags it as "changed" (a degraded snippet
// vs a recorded full model would otherwise differ). `cfn` fetches the child type's schema
// (readOnly/writeOnly strip); `schemas` is the shared cache.
export async function readAddedModel(
  cc: CloudControlClient,
  cfn: CloudFormationClient,
  c: AddedChild,
  schemas: Map<string, SchemaInfo>,
  oaiCanonicalIds: Record<string, string>
): Promise<{ model: Record<string, unknown>; ok: boolean }> {
  // Normalize a raw live model with the (cached) child-type schema. Only re-cache a SUCCESSFUL
  // fetch: a DescribeType failure returns an EMPTY schema (#751 — schema-strip itself does not
  // cache it), and caching that EMPTY in the per-run map would poison every later resource of
  // this type (writeOnly reinclude drops declared write-only props, createOnly bars lost) even
  // after the throttle clears — so leave the map unset on failure to let the next occurrence
  // re-fetch (#1067). The EMPTY still drives THIS resource's normalize (degraded, no strip).
  const normalizeWith = async (
    raw: Record<string, unknown>
  ): Promise<{ model: Record<string, unknown>; ok: true }> => {
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
  };
  // #1431: a NON_PROVISIONABLE type's CC GetResource always fails — skip it and use the
  // enumerator's full `live` snippet as the recordable model, so record/ignore can endorse it.
  if (CC_GET_UNSUPPORTED_ADDED_TYPES.has(c.resourceType)) {
    return normalizeWith(c.live);
  }
  try {
    const g = await cc.send(
      new GetResourceCommand({ TypeName: c.resourceType, Identifier: c.identifier })
    );
    const raw = JSON.parse(g.ResourceDescription?.Properties ?? '{}') as Record<string, unknown>;
    return normalizeWith(raw);
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

// The child may carry EXPLICIT foreign-scope metadata that the physical-id ARN parse cannot see
// (#1322). An AWS::SNS::Subscription's physical id is `<topicArn>:<uuid>` — always minted under
// the TOPIC's (= this check's) account+region, so `isDefinitiveNotManaged` always reads it LOCAL
// even when a FOREIGN subscriber stack owns it. `ListSubscriptionsByTopic` DOES return the true
// scope: `Owner` (the subscription's owning account) and, for a cross-account / cross-region
// fan-out, an ARN `Endpoint` carrying the subscriber's account+region. When either signals a
// foreign scope, a ValidationError from the local DescribeStackResources is UNVERIFIABLE (the
// owning stack is simply unreachable from here), so it must NOT be a definitive not-managed.
export function hasForeignScopeSignal(c: AddedChild, accountId: string, region: string): boolean {
  const owner = c.ownerAccountId;
  if (typeof owner === 'string' && owner !== '' && owner !== accountId) {
    return true;
  }
  return (c.scopeArns ?? []).some(
    (arn) => arn.startsWith('arn:') && !isDefinitiveNotManaged(arn, accountId, region)
  );
}

// Probe ONE candidate CloudFormation physical id against the run's account+region: does a
// stack own a resource of THIS child's type (`c.resourceType`) with this exact physical id?
// Returns the tri-state and memoizes any DEFINITIVE answer per physical id (a transient
// throttle / unverifiable foreign-scope id is left un-cached so a retry can resolve it).
// The memo MUST be keyed by `${resourceType}|${physicalId}`, not the physical id alone: the
// `owns` predicate gates on `ResourceType === c.resourceType`, so the SAME physical id can be
// 'managed' for one child type yet 'notManaged' for another (#1310). Two child types can share
// a segment name — e.g. a shared log group's MetricFilter and SubscriptionFilter fan-out both
// probe a `errors` segment — and a type-blind cache would replay a MetricFilter's 'managed'
// answer for a SubscriptionFilter of the same name, folding a rogue OOB subscription filter to
// managed. Keying by type keeps each type's answer independent.
async function probeSiblingPhysicalId(
  cfn: CloudFormationClient,
  c: AddedChild,
  physicalId: string,
  cache: Map<string, SiblingCheck>,
  accountId: string,
  region: string
): Promise<SiblingCheck> {
  const cacheKey = `${c.resourceType}|${physicalId}`;
  const cached = cache.get(cacheKey);
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
    // done — we leave it un-cached like the other unverifiable cases for uniform handling. The
    // ARN parse is a GENERIC backstop, but it MISREADS a child whose physical id is always local
    // to its parent yet may be foreign-owned (an SNS Subscription arn is `<topicArn>:<uuid>`),
    // so an EXPLICIT foreign-scope metadata signal (`Owner` / ARN `Endpoint`) overrides it and
    // also downgrades this to `unverified` (#1322).
    if (
      (e as { name?: string }).name === 'ValidationError' &&
      isDefinitiveNotManaged(physicalId, accountId, region) &&
      !hasForeignScopeSignal(c, accountId, region)
    ) {
      cache.set(cacheKey, 'notManaged');
      return 'notManaged';
    }
    return 'unverified';
  }
  const result: SiblingCheck = managed ? 'managed' : 'notManaged';
  cache.set(cacheKey, result);
  return result;
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
  // A `siblingLookupId` explicitly set by the enumerator (Events::Rule custom-bus
  // `<busName>|<ruleName>`) IS a valid CFn physical id verbatim (even with a `|`), so probe it
  // as-is. Only the CC `identifier` composites — which NEVER set `siblingLookupId` — need the
  // per-segment fan-out below.
  if (c.siblingLookupId !== undefined || !physicalId.includes('|')) {
    return probeSiblingPhysicalId(cfn, c, physicalId, cache, accountId, region);
  }
  // A pipe-composite CC identifier (`ServiceArn|Cluster`, `UserPoolId|ClientId`,
  // `LogGroupName|FilterName`, …) is the join of a PARENT id + the child's own id — and the
  // child's CFn PHYSICAL id is the BARE half (ECS = ServiceArn, Cognito = ClientId, Logs =
  // FilterName). A shared-parent split (a cluster stack + per-service stacks, an auth stack +
  // app stacks) makes such a child fully CloudFormation-managed by a SIBLING stack, yet the
  // old wholesale `physicalId.includes('|') → 'notManaged'` short-circuit false-flagged every
  // one `added` with a destructive DeleteResource revert offer (#800). Which segment is the
  // child's physical id varies per type (first, second, and the two Logs filter types even
  // ORDER it oppositely), so probe EACH segment; the `owns` predicate already gates on
  // `ResourceType === c.resourceType`, so a segment that is the (differently-typed) parent id
  // — or a non-physical-id half of a genuine within-stack API Gateway / Cognito sub-resource —
  // never false-matches, and those simply fall through to `notManaged`/`unverified` as before.
  // Combine the segment results fail-SAFE: ANY segment proving sibling ownership wins
  // ('managed'); otherwise if ANY segment was UNVERIFIABLE (throttle / foreign-scope) return
  // 'unverified' (report as coverage-incomplete, never a destructive delete — #754); only when
  // EVERY segment is a definitive not-managed is the composite a genuine out-of-band `added`.
  let sawUnverified = false;
  for (const segment of physicalId.split('|')) {
    if (!segment) continue; // skip an empty segment (defensive: leading/trailing/double `|`)
    const seg = await probeSiblingPhysicalId(cfn, c, segment, cache, accountId, region);
    if (seg === 'managed') return 'managed';
    if (seg === 'unverified') sawUnverified = true;
  }
  return sawUnverified ? 'unverified' : 'notManaged';
}

interface ClassifyOpts {
  accountId: string;
  region: string;
  kmsAliasTargets: Record<string, string>;
  stackTags: Record<string, string>; // CFn stack-level tags (cdk deploy --tags), subtracted from live Tags (#683)
  oaiCanonicalIds: Record<string, string>;
  siblingSgRules: Record<string, { ingress: unknown[]; egress: unknown[] }>;
  siblingEventBusPolicies: Record<string, unknown[]>;
  siblingManagedPolicyAttachments: Record<string, string[]>;
  siblingUserGroups: Record<string, string[]>;
  siblingEipAssociations: Set<string>;
  siblingTargetGroupRegistrars: Set<string>;
  bucketNotificationManaged: Set<string>;
  // #1283: per managed-bucket physical id, the CR's DECLARED NotificationConfiguration (S3 API
  // shape) — classify translates it into the live CFn shape and equality-gates. Carried
  // alongside bucketNotificationManaged (the id set); a bucket in the set always has an entry.
  bucketNotificationConfigs: Record<string, Record<string, unknown>>;
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
// Custom::S3BucketNotifications custom resource, MAPPED to the CR's DECLARED
// `NotificationConfiguration` (the intended config, in the S3 API property shape). CDK renders
// `bucket.addEventNotification()` / `enableEventBridgeNotification()` as this CR (which cdkrd
// cannot read/verify, so it is `skipped`), NOT as the bucket's own NotificationConfiguration
// property — so the live bucket REFLECTS the CR-applied config while its template resource
// declares nothing, surfacing the whole NotificationConfiguration as false undeclared drift on
// every such bucket. The config is IaC-managed (by the CR), not out of band; classify translates
// this declared config into the live CFn resource shape and EQUALITY-GATES it against the live
// value — folding a matching (clean-deploy) config while SURFACING an out-of-band `put-bucket-
// notification-configuration` that adds / swaps / removes a target (#1283). Fail-open: a CR whose
// BucketName did not resolve to a concrete name is skipped (the bucket keeps the reflected config
// -> a one-time visible FP, never a hidden change); a CR with no `NotificationConfiguration`
// object maps to `{}` (an empty config that folds only an empty live config).
const S3_NOTIFICATIONS_CR_TYPE = 'Custom::S3BucketNotifications';
// Resolve each Custom::S3BucketNotifications CR's target bucket physical id (from its declared
// `BucketName`, a concrete name or a `Ref` to a declared bucket) paired with the CR's declared
// `NotificationConfiguration` (S3 API shape, or `{}` when absent). Shared by the two builders
// below so the id set and the config map are always derived identically.
function resolveBucketNotificationCrs(
  desired: Desired
): Array<[physicalId: string, config: Record<string, unknown>]> {
  const byLogicalId = new Map<string, string>();
  for (const r of desired.resources) if (r.physicalId) byLogicalId.set(r.logicalId, r.physicalId);
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const r of desired.resources) {
    if (r.resourceType !== S3_NOTIFICATIONS_CR_TYPE) continue;
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    const bucketName = d.BucketName;
    const rawConfig = d.NotificationConfiguration;
    const config =
      rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
        ? (rawConfig as Record<string, unknown>)
        : {};
    if (typeof bucketName === 'string' && bucketName) {
      out.push([bucketName, config]); // already resolved to the concrete bucket name (== physical id)
    } else if (bucketName && typeof bucketName === 'object' && 'Ref' in bucketName) {
      const phys = byLogicalId.get((bucketName as { Ref: string }).Ref);
      if (phys) out.push([phys, config]);
    }
  }
  return out;
}
export function buildBucketNotificationManaged(desired: Desired): Set<string> {
  return new Set(resolveBucketNotificationCrs(desired).map(([phys]) => phys));
}
// #1283: per managed-bucket physical id, the CR's DECLARED NotificationConfiguration (S3 API
// shape). classify translates it into the live CFn resource shape and equality-gates against the
// live value — folding a clean-deploy match while SURFACING an out-of-band change. Same physical-id
// resolution as buildBucketNotificationManaged, so every id in that set has a config entry here.
export function buildBucketNotificationConfigs(
  desired: Desired
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [phys, config] of resolveBucketNotificationCrs(desired)) out[phys] = config;
  return out;
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

// #975: an AWS::GlobalAccelerator::EndpointGroup that omits HealthCheckPort reads back its
// LISTENER's port (AWS resolves the schema's -1 sentinel default to the listener's first
// PortRanges FromPort). Map each AWS::GlobalAccelerator::Listener's first port, keyed by the
// listener's physical id (== its ARN, which the EndpointGroup references via the declared
// ListenerArn), so classify derives + equality-gates the undeclared HealthCheckPort (see the
// EndpointGroup block in classifyResource). Fail-open: a listener with no physical id / no numeric
// first port is skipped (its EndpointGroup then keeps the value as a one-time visible FP, never a
// hidden change).
const GA_LISTENER_TYPE = 'AWS::GlobalAccelerator::Listener';
export function buildSiblingListenerPorts(desired: Desired): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of desired.resources) {
    if (r.resourceType !== GA_LISTENER_TYPE || !r.physicalId) continue;
    const ranges = (r.declared as Record<string, unknown> | undefined)?.PortRanges;
    const first = Array.isArray(ranges) ? ranges[0] : undefined;
    const from =
      first && typeof first === 'object' ? (first as Record<string, unknown>).FromPort : undefined;
    // A raw-CFn / YAML template can carry FromPort as a quoted all-digit string ("80") that CFn
    // coerces to a number; accept it so the EndpointGroup HealthCheckPort still folds (#1268).
    const port =
      typeof from === 'number'
        ? from
        : typeof from === 'string' && /^\d+$/.test(from)
          ? Number(from)
          : undefined;
    if (port !== undefined) map[r.physicalId] = port;
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

// An AWS::EC2::EIP's live `NetworkInterfaceId` reflects the ENI its address is associated with.
// A LEGITIMATE association is DECLARED by a sibling resource — an AWS::EC2::EIPAssociation
// (`AllocationId`/`EIP` referencing the EIP, `NetworkInterfaceId`/`InstanceId` naming the target)
// or an AWS::EC2::NatGateway that consumes the EIP (`AllocationId` → the NAT owns the address, its
// ENI is a legitimate binding). An association with NO declaring sibling is out of band — an
// `ec2 associate-address` HIJACKING the allocated static IP onto an arbitrary ENI, which the old
// blanket value-independent fold hid (#892). This set holds the identities (logicalId AND
// physicalId == PublicIp) of every EIP a declared sibling associates, so classify FOLDS a
// sibling-explained `NetworkInterfaceId` and SURFACES a sibling-less one. The ENI value itself is
// AWS-assigned at association time (a NAT's ENI is created by AWS, not named in the template), so
// the gate is PRESENCE-based: a declaring sibling explains ANY live association on that EIP. Fail-
// open: an EIP reference that does not resolve to a known EIP is skipped (that EIP keeps the
// reflected id → a one-time visible finding, never a hidden change).
const EIP_ASSOCIATION_TYPE = 'AWS::EC2::EIPAssociation';
const NAT_GATEWAY_TYPE = 'AWS::EC2::NatGateway';
export function buildSiblingEipAssociations(desired: Desired): Set<string> {
  // Map every EIP's logicalId to its own identities (logicalId + physicalId == PublicIp) so a
  // sibling referencing the EIP by `{Ref: <eipLogicalId>}` (or by a GetAtt on it) can be resolved
  // to the identities classify looks the EIP up by.
  const eipIdentities = new Map<string, string[]>();
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::EC2::EIP') continue;
    const ids = [r.logicalId];
    if (r.physicalId) ids.push(r.physicalId);
    eipIdentities.set(r.logicalId, ids);
  }
  const associated = new Set<string>();
  const markEip = (ref: unknown): void => {
    // A sibling names its EIP by `AllocationId`/`EIP`: a `{Ref: <eipLogicalId>}`, a
    // `{Fn::GetAtt: [<eipLogicalId>, AllocationId]}`, or (for `EIP`) the resolved public-IP string.
    // Resolve any of these to the EIP's identities and mark them all as sibling-explained.
    let eipLogicalId: string | undefined;
    if (ref && typeof ref === 'object') {
      if ('Ref' in ref && typeof (ref as { Ref: unknown }).Ref === 'string') {
        eipLogicalId = (ref as { Ref: string }).Ref;
      } else if ('Fn::GetAtt' in ref) {
        const g = (ref as { 'Fn::GetAtt': unknown })['Fn::GetAtt'];
        if (Array.isArray(g) && typeof g[0] === 'string') eipLogicalId = g[0];
      }
    }
    if (eipLogicalId !== undefined) {
      const ids = eipIdentities.get(eipLogicalId);
      if (ids) for (const id of ids) associated.add(id);
      return;
    }
    // A resolved public-IP string (the `EIP` form) — mark it directly (it == the EIP's physical id).
    if (typeof ref === 'string' && ref) associated.add(ref);
  };
  for (const r of desired.resources) {
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    if (r.resourceType === EIP_ASSOCIATION_TYPE) {
      markEip(d.AllocationId);
      markEip(d.EIP);
    } else if (r.resourceType === NAT_GATEWAY_TYPE) {
      markEip(d.AllocationId); // the NAT owns the EIP → its ENI is a legitimate association
    }
  }
  return associated;
}

// An AWS::ElasticLoadBalancingV2::TargetGroup's live `Targets` reflects whatever is REGISTERED into
// the group. When a DECLARED sibling dynamically registers targets — an AWS::ECS::Service
// (`LoadBalancers[].TargetGroupArn`), an AWS::AutoScaling::AutoScalingGroup (`TargetGroupARNs`), or
// the group's own `TargetType: lambda` (a lambda registration is managed by AWS) — the membership
// is IaC-driven runtime churn (task IPs / instances recycle), NOT template intent, so classify
// folds it. A group with NO such registrar and a NON-EMPTY live Targets is an out-of-band
// `elbv2 register-targets` — traffic interception — and must SURFACE (#891). This set holds the
// identities (logicalId AND physicalId == the TG ARN) of every TargetGroup a declared sibling (or
// its own lambda TargetType) registers into. Fail-open: a reference that does not resolve to a
// known TargetGroup is skipped (that group keeps a visible finding, never a hidden change).
const ECS_SERVICE_TYPE = 'AWS::ECS::Service';
const AUTO_SCALING_GROUP_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
export function buildSiblingTargetGroupRegistrars(desired: Desired): Set<string> {
  // Map every TargetGroup's logicalId to its own identities (logicalId + physicalId == TG ARN) and
  // also index by physicalId, so a sibling referencing the TG by `{Ref}` (== the ARN), a GetAtt, an
  // ImportValue, or the raw ARN string can be resolved to the identities classify looks it up by.
  const tgIdentitiesByLogicalId = new Map<string, string[]>();
  const tgLogicalIdByPhysicalId = new Map<string, string>();
  for (const r of desired.resources) {
    if (r.resourceType !== TARGET_GROUP_TYPE) continue;
    const ids = [r.logicalId];
    if (r.physicalId) {
      ids.push(r.physicalId);
      tgLogicalIdByPhysicalId.set(r.physicalId, r.logicalId);
    }
    tgIdentitiesByLogicalId.set(r.logicalId, ids);
  }
  const registered = new Set<string>();
  const markTg = (ref: unknown): void => {
    // A sibling names a TG by ARN: a `{Ref: <tgLogicalId>}` (resolves to the ARN), a
    // `{Fn::GetAtt: [<tgLogicalId>, ...]}`, a `{Fn::ImportValue: ...}` (cross-stack — unresolvable
    // to a local TG, skipped fail-open), or the resolved ARN string. Resolve any of these to the
    // TG's identities and mark them all as sibling-registered.
    let tgLogicalId: string | undefined;
    if (ref && typeof ref === 'object') {
      if ('Ref' in ref && typeof (ref as { Ref: unknown }).Ref === 'string') {
        tgLogicalId = (ref as { Ref: string }).Ref;
      } else if ('Fn::GetAtt' in ref) {
        const g = (ref as { 'Fn::GetAtt': unknown })['Fn::GetAtt'];
        if (Array.isArray(g) && typeof g[0] === 'string') tgLogicalId = g[0];
      }
      // A `{Fn::ImportValue: ...}` (or any other intrinsic) does not resolve to a local TG → skip.
    }
    if (tgLogicalId !== undefined) {
      const ids = tgIdentitiesByLogicalId.get(tgLogicalId);
      if (ids) for (const id of ids) registered.add(id);
      return;
    }
    // A resolved ARN string (== the TG's physical id) — mark it and its logicalId directly.
    if (typeof ref === 'string' && ref) {
      registered.add(ref);
      const logicalId = tgLogicalIdByPhysicalId.get(ref);
      if (logicalId) registered.add(logicalId);
    }
  };
  for (const r of desired.resources) {
    const decl = r.declared;
    if (!decl || typeof decl !== 'object') continue;
    const d = decl as Record<string, unknown>;
    if (r.resourceType === ECS_SERVICE_TYPE) {
      // An ECS service dynamically registers its tasks into each LoadBalancers[].TargetGroupArn.
      const lbs = d.LoadBalancers;
      if (Array.isArray(lbs)) {
        for (const lb of lbs) {
          if (lb && typeof lb === 'object') markTg((lb as Record<string, unknown>).TargetGroupArn);
        }
      }
    } else if (r.resourceType === AUTO_SCALING_GROUP_TYPE) {
      // An ASG dynamically registers its instances into each of its TargetGroupARNs.
      const arns = d.TargetGroupARNs;
      if (Array.isArray(arns)) for (const arn of arns) markTg(arn);
    } else if (r.resourceType === TARGET_GROUP_TYPE && d.TargetType === 'lambda') {
      // A lambda target group's membership is a lambda registration AWS manages — treat the TG's
      // own lambda TargetType as a registrar so its live `Targets` folds.
      const ids = tgIdentitiesByLogicalId.get(r.logicalId);
      if (ids) for (const id of ids) registered.add(id);
    }
  }
  return registered;
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

const SCALABLE_TARGET_TYPE = 'AWS::ApplicationAutoScaling::ScalableTarget';

// Every logicalId referenced by a value's intrinsics — a `{Ref: X}`, an `{Fn::GetAtt: [X, ...]}`
// (or the string `X.attr` form), the `${X}` / `${X.attr}` substitutions inside an `{Fn::Sub}`, and
// recursively through `{Fn::Join}` parts / arrays / objects. Used to link a ScalableTarget to the
// resource its `ResourceId` names (a CDK ScalableTarget builds ResourceId by interpolating a Ref /
// GetAtt to the governed service/table). Pure.
function collectRefLogicalIds(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (v == null) return out;
  if (Array.isArray(v)) {
    for (const el of v) collectRefLogicalIds(el, out);
    return out;
  }
  if (typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if ('Ref' in o && typeof o.Ref === 'string') out.add(o.Ref);
  if ('Fn::GetAtt' in o) {
    const g = o['Fn::GetAtt'];
    if (Array.isArray(g) && typeof g[0] === 'string') out.add(g[0]);
    else if (typeof g === 'string') out.add(g.split('.')[0] ?? g);
  }
  if ('Fn::Sub' in o) {
    const s = o['Fn::Sub'];
    const body = Array.isArray(s) ? s[0] : s;
    if (typeof body === 'string') {
      for (const m of body.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[^}]+)?\}/g)) {
        if (m[1]) out.add(m[1]);
      }
    }
    if (Array.isArray(s) && s[1] && typeof s[1] === 'object') collectRefLogicalIds(s[1], out);
  }
  for (const [k, val] of Object.entries(o)) {
    if (k === 'Ref' || k === 'Fn::GetAtt' || k === 'Fn::Sub') continue;
    collectRefLogicalIds(val, out);
  }
  return out;
}

// #688: per GOVERNED resource logicalId, the Application Auto Scaling bands a sibling
// AWS::ApplicationAutoScaling::ScalableTarget declares over its properties — `{ path, min, max }[]`.
// classify (applyAutoscalerBandFold) folds a declared finding whose live value is within its band
// (the autoscaler enforcing the template's own delegation — not drift) and marks an OUT-OF-BAND
// value non-revertable. Each ScalableTarget's ScalableDimension is looked up in
// AAS_SCALABLE_DIMENSIONS for the governed type + property path(s); the governed resource is linked
// by the Ref/GetAtt in the (raw) ResourceId, falling back to matching the resolved ResourceId string
// against a candidate's physical id. Fail-open at every step (an unresolved link / non-numeric band
// simply yields no fold, so the finding stays visible — never a hidden change).
export function buildScalableTargetBands(
  desired: Desired
): Record<string, { path: string; min: number; max: number }[]> {
  const byLogicalId = new Map<string, DesiredResource>();
  const byType = new Map<string, DesiredResource[]>();
  for (const r of desired.resources) {
    byLogicalId.set(r.logicalId, r);
    const arr = byType.get(r.resourceType);
    if (arr) arr.push(r);
    else byType.set(r.resourceType, [r]);
  }
  const map: Record<string, { path: string; min: number; max: number }[]> = {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  for (const r of desired.resources) {
    if (r.resourceType !== SCALABLE_TARGET_TYPE) continue;
    const decl = (r.declared ?? {}) as Record<string, unknown>;
    const dim = decl.ScalableDimension;
    if (typeof dim !== 'string') continue;
    const spec = AAS_SCALABLE_DIMENSIONS[dim];
    if (!spec) continue;

    // Band: the declared MinCapacity/MaxCapacity (intent), falling back to the live model.
    const live = desired.ctx.liveAttrs[r.logicalId] ?? {};
    const min = num(decl.MinCapacity) ?? num(live.MinCapacity);
    const max = num(decl.MaxCapacity) ?? num(live.MaxCapacity);
    if (min === undefined || max === undefined) continue;

    // Link to the governed resource: prefer a Ref/GetAtt in the raw ResourceId, of the right type.
    const rawResourceId = (r.declaredRaw as Record<string, unknown> | undefined)?.ResourceId;
    let governed: DesiredResource | undefined;
    for (const id of collectRefLogicalIds(rawResourceId)) {
      const cand = byLogicalId.get(id);
      if (cand && cand.resourceType === spec.resourceType) {
        governed = cand;
        break;
      }
    }
    // Fallback: match the resolved ResourceId string against a candidate's physical id.
    if (!governed) {
      const rid = decl.ResourceId;
      if (typeof rid === 'string') {
        const segs = new Set(rid.split('/'));
        governed = byType
          .get(spec.resourceType)
          ?.find(
            (c) =>
              c.physicalId !== undefined && (segs.has(c.physicalId) || rid.endsWith(c.physicalId))
          );
      }
    }
    if (!governed) continue;

    const entries = (map[governed.logicalId] ??= []);
    for (const path of spec.paths) entries.push({ path, min, max });
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
  // #889: prefetch the VPC-default security-group ids once (per region) when the stack declares an
  // ALB or ENI, so classify can DERIVE-gate the undeclared default-SG-list fold (ALB SecurityGroups
  // / ENI GroupSet) instead of value-independent folding it (which hid an out-of-band SG swap/append).
  // Fail open: an empty set on missing ec2:DescribeSecurityGroups / lookup failure → classify keeps
  // folding (no new first-run false positive). Mirrors the kmsAliasTargets prefetch above.
  let defaultSgIds: ReadonlySet<string> = new Set();
  if (desired.resources.some((r) => DEFAULT_SG_LIST_TYPES.has(r.resourceType))) {
    defaultSgIds = await fetchDefaultSgIds(region);
  }
  // #1269: prefetch the default-VPC subnet ids when the stack declares a RedshiftServerless
  // Workgroup, so classify can DERIVE-gate the undeclared SubnetIds fold (fold when every live
  // subnet is a default-VPC subnet, surface an OOB re-placement). Fail open, same as the SG prefetch.
  let defaultSubnetIds: ReadonlySet<string> = new Set();
  if (desired.resources.some((r) => DEFAULT_SUBNET_LIST_TYPES.has(r.resourceType))) {
    defaultSubnetIds = await fetchDefaultVpcSubnetIds(region);
  }
  // #1070: prefetch the effective account/region default settings a few undeclared defaults derive
  // from — only for the affected type present in the stack, each fail-open. Threaded into classify
  // so the ECS containerInsights / SSM default-tier / EBS encryption-by-default fold is a DERIVED
  // equality gate against the account's real setting rather than a fixed constant that FPs once the
  // owner adopts the hardening control (each NEW resource re-noising until recorded).
  const accountDefaults: AccountDefaults = {};
  if (desired.resources.some((r) => r.resourceType === 'AWS::ECS::Cluster')) {
    const v = await fetchEcsContainerInsightsDefault(region);
    if (v !== undefined) accountDefaults.ecsContainerInsights = v;
  }
  if (desired.resources.some((r) => r.resourceType === 'AWS::SSM::Parameter')) {
    const v = await fetchSsmDefaultParameterTier(region);
    if (v !== undefined) accountDefaults.ssmParameterTier = v;
  }
  if (desired.resources.some((r) => r.resourceType === 'AWS::EC2::Volume')) {
    const v = await fetchEbsEncryptionByDefault(region);
    if (v !== undefined) accountDefaults.ebsEncryptionByDefault = v;
  }
  // #1070 item 4: prefetch the account-effective default credit spec for each BURSTABLE family
  // declared by an EC2::Instance (t2/t3/t3a/t4g). Only burstable families have a credit spec, so
  // gate on the `t<digit>` prefix; a per-family lookup that fails (unsupported family / denied)
  // is simply omitted → classify falls back to the AWS factory default for that family.
  const burstableFamilies = new Set<string>();
  for (const r of desired.resources) {
    if (r.resourceType !== 'AWS::EC2::Instance') continue;
    const it = r.declared?.InstanceType;
    const fam = typeof it === 'string' ? it.split('.')[0] : undefined;
    if (fam !== undefined && /^t\d/.test(fam)) burstableFamilies.add(fam);
  }
  if (burstableFamilies.size > 0) {
    const map: Record<string, string> = {};
    for (const fam of burstableFamilies) {
      const v = await fetchEc2FamilyCreditDefault(region, fam);
      if (v !== undefined) map[fam] = v;
    }
    if (Object.keys(map).length > 0) accountDefaults.ec2FamilyCreditDefaults = map;
  }
  // #1070 item 3: prefetch the account-level IMDS defaults when the stack declares any EC2::Instance,
  // so classify can overlay the account-SET fields onto the MetadataOptions constant. Undefined
  // (nothing set at account level) → the constant stands.
  if (desired.resources.some((r) => r.resourceType === 'AWS::EC2::Instance')) {
    const v = await fetchInstanceMetadataDefaults(region);
    if (v !== undefined) accountDefaults.instanceMetadataDefaults = v;
  }
  // #1070 item 5: prefetch the account's customer-override default CA identifier when the stack
  // declares an RDS or DocDB DBInstance. Undefined (no override) → classify keeps the constant.
  if (
    desired.resources.some(
      (r) =>
        r.resourceType === 'AWS::RDS::DBInstance' || r.resourceType === 'AWS::DocDB::DBInstance'
    )
  ) {
    const v = await fetchRdsDefaultCaIdentifier(region);
    if (v !== undefined) accountDefaults.rdsDefaultCaIdentifier = v;
  }
  const classifyOpts = {
    accountId: desired.accountId,
    region,
    kmsAliasTargets,
    stackTags: desired.stackTags ?? {},
    defaultSgIds,
    defaultSubnetIds,
    accountDefaults,
    oaiCanonicalIds,
    siblingSgRules: buildSiblingSgRules(desired),
    siblingEventBusPolicies: buildSiblingEventBusPolicies(desired),
    siblingManagedPolicyAttachments: buildSiblingManagedPolicyAttachments(desired),
    siblingUserGroups: buildSiblingUserGroups(desired),
    siblingLifecycleHooks: buildSiblingLifecycleHooks(desired),
    siblingListenerPorts: buildSiblingListenerPorts(desired),
    siblingEipAssociations: buildSiblingEipAssociations(desired),
    siblingTargetGroupRegistrars: buildSiblingTargetGroupRegistrars(desired),
    bucketNotificationManaged: buildBucketNotificationManaged(desired),
    bucketNotificationConfigs: buildBucketNotificationConfigs(desired),
    clusterEchoModel: buildClusterEchoModels(desired),
    scalableTargetBands: buildScalableTargetBands(desired),
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
  // #889: mirror the primary gather's VPC-default-SG prefetch on the regather (revert re-check) path
  // so the derived SG-list gate is applied identically. Cached per region, so this is a no-op read
  // when the primary gather already resolved it. Fail open (empty set) → classify keeps folding.
  let defaultSgIds: ReadonlySet<string> = new Set();
  if (targets.some((r) => DEFAULT_SG_LIST_TYPES.has(r.resourceType))) {
    defaultSgIds = await fetchDefaultSgIds(region);
  }
  // #1269: mirror the default-VPC subnet prefetch on the regather (revert re-check) path too.
  let defaultSubnetIds: ReadonlySet<string> = new Set();
  if (targets.some((r) => DEFAULT_SUBNET_LIST_TYPES.has(r.resourceType))) {
    defaultSubnetIds = await fetchDefaultVpcSubnetIds(region);
  }
  const classifyOpts = {
    accountId: desired.accountId,
    region,
    kmsAliasTargets,
    stackTags: desired.stackTags ?? {},
    defaultSgIds,
    defaultSubnetIds,
    oaiCanonicalIds,
    siblingSgRules: buildSiblingSgRules(desired),
    siblingEventBusPolicies: buildSiblingEventBusPolicies(desired),
    siblingManagedPolicyAttachments: buildSiblingManagedPolicyAttachments(desired),
    siblingUserGroups: buildSiblingUserGroups(desired),
    siblingLifecycleHooks: buildSiblingLifecycleHooks(desired),
    siblingListenerPorts: buildSiblingListenerPorts(desired),
    siblingEipAssociations: buildSiblingEipAssociations(desired),
    siblingTargetGroupRegistrars: buildSiblingTargetGroupRegistrars(desired),
    bucketNotificationManaged: buildBucketNotificationManaged(desired),
    bucketNotificationConfigs: buildBucketNotificationConfigs(desired),
    clusterEchoModel: buildClusterEchoModels(desired),
    scalableTargetBands: buildScalableTargetBands(desired),
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

// The heart of `check`: given a resource's resolved declared properties, its raw
// live state, and its schema info, classify every difference into a tier:
//   declared    — a declared property whose live value differs
//   undeclared  — a live property not declared, after noise subtraction (the differentiator)
//   readGap     — a declared property absent from the live read (CC-API can't read it back)
//   unresolved  — a declared property whose intrinsics couldn't be resolved (GetAtt) → skip
//
// Pure: no AWS calls. liveRaw is the CC API GetResource model (un-stripped).

import jsonata from 'jsonata';
import { partitionForRegion } from '../desired/template-adapter.js';
import {
  isArnNameMatch,
  isLogGroupArnWildcardMatch,
  isManagedKmsAliasMatch,
} from '../normalize/arn-identity.js';
import { stripCcApiAwsManagedFields } from '../normalize/cc-api-strip.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import {
  CASE_INSENSITIVE_ARRAY_PATHS,
  CASE_INSENSITIVE_KEY_PATHS,
  CASE_INSENSITIVE_PATHS,
  isAllAwsTags,
  identityField,
  isCaseInsensitiveEqualScalarSet,
  isCaseInsensitiveKeyMapEqual,
  isCaseInsensitiveScalarEqual,
  BOOLEAN_PARAM_MAP_PATHS,
  isBooleanTokenEquivalent,
  isCfnTemplateNonAsciiMask,
  deepEqualModuloNonAsciiMask,
  isEqualUnorderedScalarSet,
  isEquivalentRateExpression,
  isJsonStringStructEqual,
  JSON_STRING_PROPS,
  JSON_STRING_DEFAULT_FILLS,
  isPemEqual,
  isAccessStringEqual,
  isPropertiesFileEqual,
  isSshPublicKeyEqual,
  ACCESS_STRING_PATHS,
  PROPERTIES_FILE_PATHS,
  SSH_PUBLIC_KEY_PATHS,
  isNumericStringEqualScalar,
  isStringlyEqualScalar,
  isStringlyEqualScalarArray,
  isStringlyEqualDeep,
  isGeneratedName,
  isPhysicalIdSegment,
  isTrailingDotEqual,
  isTrailingSlashEqual,
  isTrivialEmpty,
  isVersionPrefixMatch,
  isLatestSentinelMatch,
  isIntelligentTieringMatch,
  INTELLIGENT_TIERING_PATHS,
  LATEST_SENTINEL_PATHS,
  TRAILING_DOT_PATHS,
  TRAILING_SLASH_PATHS,
  GENERATED_PATHS,
  CONTEXT_DEFAULTS,
  CONTEXT_ARN_DEFAULTS,
  DEFAULT_MANAGED_NAME_PATHS,
  DESCEND_UNDECLARED_OBJECT_PATHS,
  ebOptionSettingTier,
  ENGINE_DEFAULTS,
  GENERATED_LOGICALID_PREFIX_PATHS,
  GENERATED_NESTED_PATHS,
  GENERATED_TOPLEVEL_PATHS,
  isLogicalIdPrefixedGeneratedName,
  EPOCH_HOUR_PATHS,
  IDENTITY_KEYED_DEFAULT_ELEMENTS,
  isEpochHourEqual,
  KNOWN_DEFAULT_ONE_OF,
  KNOWN_DEFAULT_ONE_OF_PATHS,
  KNOWN_DEFAULT_PATHS,
  KNOWN_DEFAULTS,
  ORDER_SIGNIFICANT_ARRAY_KEYS,
  ORDER_SIGNIFICANT_PATHS,
  READGAP_COLLECTION_PATHS,
  SCALAR_RETURNED_WHEN_SET,
  READ_NORMALIZED_DECLARED_PATHS,
  ELB_ATTRIBUTE_DEFAULTS,
  ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE,
  NAME_VALUE_SUBSET_PATHS,
  alignNameValueSubset,
  RATE_EXPRESSION_PATHS,
  resolveGeneratedDefault,
  sortNestedObjectArrays,
  sortUnorderedObjectArray,
  stripAsymmetricIdentityFields,
  stripAwsTagsDeep,
  UNORDERED_ARRAY_PROPS,
  UNORDERED_NESTED_OBJECT_ARRAY_PATHS,
  UNORDERED_OBJECT_ARRAY_IDENTITY,
  UNORDERED_OBJECT_ARRAY_PROPS,
  VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS,
  VERSION_PREFIX_PATHS,
} from '../normalize/noise.js';
import { MANAGED_KEY_ALIAS_PATHS, shouldFoldManagedServiceKey } from '../read/kms-aliases.js';
import { deepStripPaths } from '../normalize/path-strip.js';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import { canonicalizePolicy, rewriteOaiPrincipalsDeep } from '../normalize/policy-canonical.js';
import { declaredTagKeys, subtractPropagatedStackTags } from '../normalize/stack-tags.js';
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
  'AWS::ElasticLoadBalancingV2::Listener': 'ListenerAttributes',
};

// #632: undeclared KNOWN_DEFAULTS pins whose OFF state (a live `false`/`""` that DIVERGES
// from the pinned default) is a REAL, detectable divergence — an out-of-band DISABLE of a
// switch AWS materialized ON at creation. The undeclared loop otherwise drops any `false`/`""`
// via isTrivialEmpty BEFORE the fold table is consulted ("false does not stay meaningful",
// which keeps feature-off husks quiet), so a `true→false` flip of such a switch was
// completely invisible — undetectable, unbaselineable by `record`, unrevertable (SQS SSE-SQS
// disable + KMS key disable both proven live 2026-07-08). This is CURATED + predicate-gated,
// NOT a blanket "any diverging false surfaces": most "default true" booleans are CONDITIONAL
// (true only in a specific config, legitimately `false` otherwise), so a blanket rule would
// false-positive on every such clean deploy — e.g. an SSE-KMS SQS queue reads
// SqsManagedSseEnabled=false legitimately (mutually exclusive with SSE-SQS), and a non-HTTPS
// Route53 HealthCheck reads EnableSNI=false. The predicate returns true only when the OFF
// state is a genuine divergence in THIS resource's config. Add an entry ONLY after a live
// confirm that the OFF state is meaningful in EVERY clean-deploy configuration of the type.
type OffStateContext = { declared: Record<string, unknown>; live: Record<string, unknown> };
const MEANINGFUL_WHEN_OFF: Record<string, Record<string, (ctx: OffStateContext) => boolean>> = {
  // A KMS key is always created enabled; `disable-key` (Enabled=false) is always meaningful.
  'AWS::KMS::Key': { Enabled: () => true },
  // SSE-SQS defaults ON, but is mutually exclusive with SSE-KMS: a queue that uses a KMS key
  // reads SqsManagedSseEnabled=false legitimately. Surface the OFF state only when the queue
  // uses no KMS key — i.e. encryption was genuinely disabled out of band.
  'AWS::SQS::Queue': {
    SqsManagedSseEnabled: ({ declared, live }) =>
      declared['KmsMasterKeyId'] === undefined && live['KmsMasterKeyId'] === undefined,
  },
  // #632 follow-up — the UNCONDITIONAL top-level members of the blast radius: a fresh deploy
  // ALWAYS reads these `true` (confirmed across the committed corpus, no false-on-clean case,
  // no restore/import/legacy path that yields an untouched `false`), so an undeclared `false`
  // is unambiguously an out-of-band disable. (The DB `AutoMinorVersionUpgrade` /
  // `AllowVersionUpgrade`, ELBv2 TargetGroup `HealthCheckEnabled` (Lambda-target conditional),
  // and the nested Athena/EKS/Cognito-password/EnableSNI switches are DEFERRED to a live-verified
  // follow-up — a snapshot-restored DB / a Lambda target group can read `false` legitimately.)
  //
  // A VPC always resolves DNS by default; disabling it out of band breaks name resolution.
  'AWS::EC2::VPC': { EnableDnsSupport: () => true },
  // Source/dest checking is ON for every ENI/instance at launch (a NAT declares `false`); an
  // undeclared `false` means it was turned into a router out of band.
  'AWS::EC2::Instance': { SourceDestCheck: () => true },
  'AWS::EC2::NetworkInterface': { SourceDestCheck: () => true },
  // A user-pool client is created with token revocation ON; an undeclared `false` disables it.
  'AWS::Cognito::UserPoolClient': { EnableTokenRevocation: () => true },
  // A composite alarm is created with its actions ON; an undeclared `false` silences them.
  'AWS::CloudWatch::CompositeAlarm': { ActionsEnabled: () => true },
  // A minimal ApplicationInsights application always reads back CWEMonitorEnabled=true (AWS
  // enables CloudWatch Events monitoring at creation even though the CFn schema annotates the
  // default as false — the KNOWN_DEFAULTS pin), so an OFF state (a live/declared `false`) is an
  // out-of-band DISABLE of that monitoring toggle and is meaningful. Live-confirmed (#841/#925).
  'AWS::ApplicationInsights::Application': { CWEMonitorEnabled: () => true },
  // #1092: a GuardDuty detector is created with its legacy DataSources surface FULLY enabled
  // (the KNOWN_DEFAULTS pin: S3 protection, EKS audit logs, EBS-malware all true). A single-
  // source disable already surfaces (the object keeps a `true` leaf, so it is not trivially
  // empty). But disabling EVERY legacy source at once turns DataSources into an ALL-FALSE
  // object, which isTrivialEmpty would swallow BEFORE the pin gate — hiding a wholesale
  // security disable. It is unconditionally meaningful when off, so surface it.
  'AWS::GuardDuty::Detector': { DataSources: () => true },
};

// #1092: GuardDuty protection Features whose new-detector default Status is DISABLED (not the
// ENABLED norm) — a newer/preview protection AWS ships OFF by default. Its DISABLED state on a
// clean detector is the default (folds), so only these names are exempt from the "ENABLED is the
// default" rule below. Extend as AWS ships more OFF-by-default features.
const GUARDDUTY_DEFAULT_DISABLED_FEATURES: ReadonlySet<string> = new Set(['AI_ANALYST']);
// True when every GuardDuty Feature (and every nested AdditionalConfiguration entry) is at its
// per-name default Status — ENABLED for every protection except the known OFF-by-default set.
// Name-independent for UNKNOWN names (a brand-new protection AWS ships ENABLED still folds), but
// an out-of-band disable of a protection whose default is ENABLED (RUNTIME_MONITORING,
// RDS_LOGIN_EVENTS, LAMBDA_NETWORK_LOGS — none have a legacy DataSources mirror) surfaces. Errs
// toward VISIBILITY: a future OFF-by-default feature not yet in the set surfaces (a recordable FP)
// rather than hiding a real security downgrade.
function guardDutyFeaturesAllAtDefault(features: unknown[]): boolean {
  const atDefault = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.every(atDefault);
    if (node !== null && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if ('Status' in rec) {
        const name = typeof rec['Name'] === 'string' ? rec['Name'] : '';
        const defaultStatus = GUARDDUTY_DEFAULT_DISABLED_FEATURES.has(name)
          ? 'DISABLED'
          : 'ENABLED';
        if (rec['Status'] !== defaultStatus) return false;
      }
      return Object.values(rec).every(atDefault);
    }
    return true;
  };
  return features.every(atDefault);
}

// #889: UNDECLARED, MUTABLE security-group lists whose AWS first-run default is exactly the
// resource's VPC default security group — one group. These were folded VALUE-INDEPENDENT
// (tier 3), which HID an out-of-band SG swap/attach (`elbv2 set-security-groups`,
// `ec2 modify-network-interface-attribute --groups`): an attacker replacing or APPENDING a
// wide-open SG on an undeclared-SG ALB/ENI read CLEAN forever and survived record. The default
// is a single group and DERIVABLE (tier 2): gather.ts prefetches the account/region VPC-default
// SG ids (one `DescribeSecurityGroups(group-name=default)` call) into `opts.defaultSgIds`.
//   `AWS::ElasticLoadBalancingV2::LoadBalancer` `SecurityGroups`
//   `AWS::EC2::NetworkInterface` `GroupSet`
// The gate folds ONLY when the live list is exactly ONE element AND that element is a known VPC
// default SG id — a 2+-element list (APPEND) or a single NON-default SG (SWAP) SURFACES. We key
// the fold on the SET of default SG ids rather than a VpcId lookup because the ALB Cloud Control
// model carries no `VpcId` (an ENI does, but a set is uniform and needs no per-resource VpcId);
// every VPC's default SG is an equally legitimate "AWS default", so a single-element list that is
// any VPC default folds. Fail OPEN — when the prefetch is unavailable (missing
// ec2:DescribeSecurityGroups / lookup failed → `defaultSgIds` undefined or empty) KEEP folding, so
// a clean deploy never gains a first-run false positive; the derived detection is best-effort and
// requires the DescribeSecurityGroups permission.
const DEFAULT_SG_LIST_PATHS: Record<string, string> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'SecurityGroups',
  'AWS::EC2::NetworkInterface': 'GroupSet',
  // #976: a Neptune DBCluster that declares no VpcSecurityGroupIds reads back the VPC's DEFAULT
  // security group — a single SG, the same AWS first-run default the ALB/ENI cases fold. It is
  // OOB-mutable (`ModifyDBCluster --vpc-security-group-ids`), so a value-independent fold would
  // hide an out-of-band SG swap/append (the exact security FN #889 fixed). Gate it through the
  // same derived VPC-default-SG check: fold a single default SG, surface an append or a swap.
  'AWS::Neptune::DBCluster': 'VpcSecurityGroupIds',
  // #1266: an AmazonMQ Broker that declares no SecurityGroups reads back the VPC default SG — the
  // same single-SG AWS first-run default the ALB/ENI/Neptune cases fold. It is OOB-mutable
  // (`mq update-broker --security-groups`; SecurityGroups is NOT in the schema createOnlyProperties,
  // unlike SubnetIds), so a value-independent fold would hide a rogue SG swap/append. Gate it
  // through the same derived VPC-default-SG check: fold a single default SG, surface an append/swap.
  'AWS::AmazonMQ::Broker': 'SecurityGroups',
  // #1269: a RedshiftServerless Workgroup that declares no SecurityGroupIds is placed into the
  // account's default VPC and reads back that VPC's default SG (a single SG, #958-live). It is
  // OOB-mutable (`redshift-serverless update-workgroup --security-group-ids`; createOnlyProperties
  // is NamespaceName/WorkgroupName only), so a value-independent fold hid a rogue SG swap/append.
  // Same derived VPC-default-SG check: fold a single default SG, surface an append/swap.
  'AWS::RedshiftServerless::Workgroup': 'SecurityGroupIds',
};
/** #1269 fold decision for an UNDECLARED default-SUBNET list (RedshiftServerless Workgroup
 *  SubnetIds). Unlike the SG gate (which folds only a SINGLE default SG), a workgroup placed into
 *  the default VPC reads back ALL of that VPC's subnets, so the clean-deploy list has MANY
 *  elements — fold when EVERY element is a known default-VPC subnet; surface if ANY subnet is
 *  outside the default VPC (an out-of-band re-placement, e.g. into a public subnet).
 *   - `true`  → FOLD (atDefault): every live subnet is a default-VPC subnet, OR the prefetch is
 *               unavailable (fail OPEN — no ec2:DescribeSubnets / lookup failed / empty).
 *   - `false` → SURFACE (undeclared): at least one live subnet is NOT a default-VPC subnet.
 *  Pure; `defaultSubnetIds` is the resolved set of default-VPC subnet ids (undefined/empty when
 *  unresolved). */
export function shouldFoldDefaultSubnetList(
  resourceType: string,
  key: string,
  liveValue: unknown,
  defaultSubnetIds?: ReadonlySet<string>
): boolean {
  if (DEFAULT_SUBNET_LIST_PATHS[resourceType] !== key) return false; // not a gated subnet-list path
  if (!defaultSubnetIds || defaultSubnetIds.size === 0) return true; // fail OPEN (unchanged behavior)
  if (!Array.isArray(liveValue)) return true;
  return liveValue.every((s) => typeof s === 'string' && defaultSubnetIds.has(s));
}
const DEFAULT_SUBNET_LIST_PATHS: Record<string, string> = {
  'AWS::RedshiftServerless::Workgroup': 'SubnetIds',
};
/** #889 fold decision for an UNDECLARED default-SG list (ALB SecurityGroups / ENI GroupSet).
 *  Returns whether the value-independent fold should still apply for this live value:
 *   - `true`  → FOLD (atDefault): the live list is a single VPC-default SG id, OR the prefetch is
 *               unavailable (fail OPEN — no ec2:DescribeSecurityGroups / lookup failed / empty).
 *   - `false` → SURFACE (undeclared): the live list has 2+ elements (an out-of-band SG APPEND) or
 *               a single NON-default SG (an out-of-band SWAP) — a real, security-relevant drift.
 *  Pure; `defaultSgIds` is the resolved set of VPC-default SG ids (undefined/empty when unresolved).*/
export function shouldFoldDefaultSgList(
  resourceType: string,
  key: string,
  liveValue: unknown,
  defaultSgIds?: ReadonlySet<string>
): boolean {
  if (DEFAULT_SG_LIST_PATHS[resourceType] !== key) return false; // not a gated SG-list path
  // Fail OPEN: no resolved default-SG ids (prefetch missing / denied / empty) → keep folding,
  // preserving today's value-independent behavior (no new first-run false positive).
  if (!defaultSgIds || defaultSgIds.size === 0) return true;
  if (!Array.isArray(liveValue)) return true; // non-array live value → fold (unchanged behavior)
  // Strict: fold ONLY a single-element list whose one SG is a known VPC default. A 2+-element
  // list (APPEND) or a single non-default SG (SWAP) falls through to the undeclared tier.
  return (
    liveValue.length === 1 && typeof liveValue[0] === 'string' && defaultSgIds.has(liveValue[0])
  );
}

// Identity-keyed object arrays where the template declares only a SUBSET of the elements
// AWS always returns — keyed by the property -> the element's identity field. Cognito
// UserPool `Schema` is the case: AWS returns all ~21 standard attributes (sub, email,
// phone_number, …) plus any custom ones, every time, regardless of what the template
// declares. Comparing the declared subset positionally against the full live array is a
// length-mismatch whole-array FALSE positive on the first check of any pool that sets
// `standardAttributes`/`customAttributes` (extremely common). The declared loop aligns
// the declared elements to live BY this identity, compares them element-wise, and emits
// the live-only elements as nested undeclared inventory (foldable, recordable) — so a
// genuine out-of-band CUSTOM attribute addition still surfaces, but the standard-attribute
// baseline no longer false-drifts. (Distinct from ELB bags, which are {Key,Value} and
// revert by Key; these are rich objects compared by subset.)
interface SubsetArraySpec {
  idField: string;
  // normalize the identity before matching: Cognito stores a custom attribute the
  // template declares as `tier` under the live Name `custom:tier` (and a developer-only
  // one as `dev:tier`), so an exact-Name match would treat the declared attribute as
  // removed (a false declared drift). Strip those AWS-added prefixes on both sides.
  normalizeId?: (id: string) => string;
  // Fold a LIVE-ONLY element to `atDefault` (not `undeclared`) when everything on it
  // EXCEPT its identity field is trivially-empty — a pure AWS-materialized HUSK the user
  // never declared and cannot meaningfully own. A Site-to-Site VPN always has exactly two
  // tunnels, so declaring one `VpnTunnelOptionsSpecifications` spec makes AWS assign the
  // other with an AWS-picked TunnelInsideCidr and every crypto/IKE list left `[]` (= "all
  // algorithms allowed", the default) plus a LogOptions-off default — a husk that must not
  // surface as first-run [Potential Drift] (#618). OFF by default: BlockDeviceMappings /
  // Cognito Schema extra elements carry real content, so they still surface (fail-closed).
  foldHuskExtras?: boolean;
}
const stripCognitoAttrPrefix = (id: string): string => id.replace(/^(custom|dev):/, '');
const IDENTITY_KEYED_SUBSET_ARRAYS: Record<string, Record<string, SubsetArraySpec>> = {
  'AWS::Cognito::UserPool': { Schema: { idField: 'Name', normalizeId: stripCognitoAttrPrefix } },
  // An EC2 Instance's BlockDeviceMappings is a SET keyed by DeviceName, and the live
  // model is a SUPERSET of the template's in two ways: (1) the API enriches each declared
  // mapping's `Ebs` block with defaults the template never set (SnapshotId, the encrypting
  // KmsKeyId, the resolved Iops/Throughput); (2) a volume ATTACHED out of band — or via a
  // sibling AWS::EC2::VolumeAttachment — appears as an EXTRA mapping (e.g. `/dev/sdf`) the
  // Instance template never declared. A positional/whole-array compare then false-flags the
  // entire BlockDeviceMappings as declared drift on every fresh deploy. Aligning declared
  // mappings to live BY DeviceName lets each declared mapping subset-compare against its live
  // twin (the enriched Ebs keys are an undeclared superset, not a declared change) and emits
  // each live-only mapping as nested undeclared inventory. A genuinely removed declared
  // mapping (no live DeviceName match) still surfaces as declared drift. Observed live on a
  // fresh ec2-instance-rich deploy (a gp3 root volume + an attached data volume).
  // An EC2 Instance's `Volumes` (EBS volumes ATTACHED at launch, each {Device, VolumeId})
  // is the same superset shape as BlockDeviceMappings: the live model adds the AMI's ROOT
  // volume (e.g. `/dev/xvda`) — which the template never declares as an attachment — as an
  // EXTRA element, and AWS may interleave it among the declared attachments. A positional/
  // whole-array compare then false-flags the entire `Volumes` as declared drift on every
  // fresh deploy of an instance that attaches volumes. Aligning declared volumes to live BY
  // Device lets each declared attachment subset-compare against its live twin and emits the
  // live-only root volume as nested undeclared inventory (recordable). A genuinely detached
  // declared volume (no live Device match) still surfaces as declared drift. Observed live
  // on a fresh ec2-instance-sets deploy (two attached gp3 volumes + the AMI root). (The
  // sibling `NetworkInterfaces` set was tested in the SAME deploy declared non-sorted by
  // DeviceIndex and AWS PRESERVED its order — subset-clean, so it is NOT folded.)
  'AWS::EC2::Instance': {
    BlockDeviceMappings: { idField: 'DeviceName' },
    Volumes: { idField: 'Device' },
  },
  // A Cognito UserPoolUser's UserAttributes is a SET keyed by Name where the live model
  // is a SUPERSET of the template's: AWS ALWAYS injects the server-generated immutable
  // `sub` (the user id), plus `email_verified`/`phone_number_verified` once those
  // attributes exist — none of which the template declares. A positional/whole-array
  // compare then false-flags the entire UserAttributes as declared drift on every fresh
  // deploy of a user that declares any attribute (e.g. just `email`). Aligning declared
  // attributes to live BY Name lets each declared attribute subset-compare against its
  // live twin and emits the live-only attributes (sub, *_verified) as nested undeclared
  // inventory (foldable, recordable). A genuinely changed declared attribute (e.g. a new
  // email) still surfaces. Exposed once UserPoolUser became CC-readable (router.ts adapter
  // above); observed live on a fresh cognito-userpooluser-rich deploy (sub injected).
  'AWS::Cognito::UserPoolUser': { UserAttributes: { idField: 'Name' } },
  // A Route53Resolver ResolverEndpoint's `IpAddresses` is a SET keyed by SubnetId where
  // the template declares only `{SubnetId}` (letting AWS assign the IP) but the live model
  // is a SUPERSET: AWS fills in the assigned `Ip` (+ `IpId`/`Status`) per entry AND returns
  // the entries in a NON-deterministic order. A positional compare then false-flags each
  // shifted entry's `SubnetId` as declared drift on a freshly recorded endpoint — and the
  // resulting phantom revert FAILS (writing the SubnetId-only entry back makes AWS re-pick
  // an IP → `[RSLVR-00405] … not in subnet CIDR range or is reserved`). SubnetId is NOT one
  // of the global IDENTITY_FIELDS, so only this per-type key aligns it. Aligning declared
  // entries to live BY SubnetId neutralizes the reorder and subset-compares each declared
  // `{SubnetId}` against its live twin (the assigned Ip/IpId are undeclared inventory,
  // foldable/recordable); a genuinely changed subnet still surfaces. Assumes one IP per
  // subnet (the hybrid-DNS norm — one endpoint IP per AZ); multiple IPs in one subnet would
  // collapse on the key, an accepted edge case. Surfaced by the issue #467 --wait live-test.
  'AWS::Route53Resolver::ResolverEndpoint': { IpAddresses: { idField: 'SubnetId' } },
  // A Site-to-Site VPN's `VpnTunnelOptionsSpecifications` is a SET keyed by TunnelInsideCidr
  // whose live model is a SUPERSET of the template's in two ways (#618): (1) AWS fills each
  // declared spec with service defaults the template never set — 7 empty crypto/IKE lists
  // (`[]` = "all algorithms allowed") plus a `LogOptions.CloudwatchLogOptions` off-default —
  // an undeclared superset per element, not a declared change; (2) a VPN ALWAYS has exactly
  // two tunnels, so declaring one spec makes AWS materialize the OTHER with an AWS-assigned
  // TunnelInsideCidr and the same all-default body. A positional/whole-array compare then
  // false-flags the whole array as DECLARED drift on a clean deploy — which SURVIVES `record`
  // and whose `wholeArrayRevert` would push a 1-tunnel array at a live 2-tunnel VPN (service-
  // disruptive). Align by TunnelInsideCidr so each declared spec subset-compares against its
  // live twin (the default-filled keys fold as trivially-empty undeclared inventory), and
  // fold the AWS-materialized second tunnel — an all-default husk — to `atDefault` via
  // foldHuskExtras. A genuinely removed/edited declared tunnel spec still surfaces.
  'AWS::EC2::VPNConnection': {
    VpnTunnelOptionsSpecifications: { idField: 'TunnelInsideCidr', foldHuskExtras: true },
  },
};
// #844: identity-keyed live-only elements to fold VALUE-INDEPENDENT (atDefault) by identity —
// keyed by resourceType -> property -> the SET of identity values that are AWS-assigned. Unlike
// IDENTITY_KEYED_DEFAULT_ELEMENTS (which deep-equals a curated fixed shape), these carry a
// per-resource AWS-generated value that has no fixed shape to match, so the fold is by identity
// alone. Cognito UserPoolUser's `sub` is the server-generated immutable user id (a per-user UUID
// assigned at creation, never declared) — it must fold, but ONLY `sub`: a console/OOB-added
// attribute (e.g. `custom:role`, `email_verified`) is NOT in the set, so it still surfaces
// undeclared (folding all UserAttributes would hide out-of-band attribute injection = a security
// FN). Consulted from BOTH subset blocks (declared and undeclared UserAttributes).
const VALUE_INDEPENDENT_KEYED_ELEMENTS: Record<string, Record<string, ReadonlySet<string>>> = {
  'AWS::Cognito::UserPoolUser': { UserAttributes: new Set(['sub']) },
};
// Nested object-arrays whose element identity is a NON-standard field (not Key/Id/
// AttributeName/IndexName/Name). collectNestedUndeclared aligns identity-keyed arrays so a
// live-only sub-key inside a declared element surfaces; without a known identity it skips
// the array entirely (reorder-unsafe to descend by position) — silently HIDING such a
// sub-key. Keyed by resourceType -> nested array path (brackets stripped) -> identity field.
//   - AWS::ApiGateway::Method Integration.IntegrationResponses is keyed by StatusCode, so an
//     out-of-band SelectionPattern / ContentHandling added to a declared response (the
//     "HTTP error regex" / "content handling" console knobs) is otherwise invisible.
export const NESTED_ARRAY_IDENTITY: Record<string, Record<string, string>> = {
  'AWS::ApiGateway::Method': {
    'Integration.IntegrationResponses': 'StatusCode',
    // MethodResponses is keyed by StatusCode too. AWS does NOT auto-materialize its
    // ResponseModels (a CFn-created method response declaring none reads back null —
    // proven live), so an out-of-band `responseModels` (e.g. the built-in "Error" model
    // attached in the console) surfaces as a genuine undeclared value, no FP.
    MethodResponses: 'StatusCode',
  },
  // A Backup plan's rules are keyed by RuleName. AWS MATERIALIZES defaults into each live
  // rule (CompletionWindowMinutes / StartWindowMinutes / ScheduleExpressionTimezone, plus
  // empty CopyActions/ScanActions/IndexActions/RecoveryPointTags) — folded via
  // KNOWN_DEFAULT_PATHS + isTrivialEmpty — so a clean plan stays clean, but an out-of-band
  // change to a compliance-relevant rule setting (e.g. a shortened CompletionWindowMinutes)
  // surfaces. Proven live.
  'AWS::Backup::BackupPlan': { 'BackupPlan.BackupPlanRule': 'RuleName' },
  // A Route53 Resolver DNS-firewall rule group's rules are keyed by Priority. AWS
  // materializes defaults into each live rule (FirewallThreatProtectionId NOT_APPLICABLE,
  // FirewallDomainRedirectionAction INSPECT_REDIRECTION_DOMAIN) — folded via
  // KNOWN_DEFAULT_PATHS — so a security-relevant out-of-band change (a rule's Action /
  // BlockResponse flipped in the console) surfaces. Proven live.
  'AWS::Route53Resolver::FirewallRuleGroup': { FirewallRules: 'Priority' },
  // A multi-region secret's replicas are keyed by Region. AWS materializes the default
  // AWS-managed KMS key (KmsKeyId `alias/aws/secretsmanager`) into each declared replica
  // that did not pin one — folded via KNOWN_DEFAULT_PATHS — so a replica re-keyed to a
  // different CMK out of band (a compliance-relevant change) surfaces. Proven live.
  'AWS::SecretsManager::Secret': { ReplicaRegions: 'Region' },
  // A REST API stage's per-method settings are keyed by HttpMethod (the dominant CDK shape
  // is a single `*` deployment-wide default). AWS materializes the caching scalar default
  // into each declared method setting (CacheTtlInSeconds 300 — folded via
  // KNOWN_DEFAULT_PATHS; the sibling `false` defaults fold via isTrivialEmpty) — so an
  // out-of-band caching change on a declared method surfaces. Proven live.
  'AWS::ApiGateway::Stage': { MethodSettings: 'HttpMethod' },
};

// Child resources whose live model ECHOES their parent's cluster-level configuration. An
// Aurora DBInstance reports the DBCluster's encryption / engine version / backup / security
// groups / subnet group / master user / log exports — settings the CDK `ClusterInstance`
// never declares on the instance, so they flood a first run as undeclared inventory that
// merely mirrors the cluster (which cdkrd classifies independently). classify drops an
// UNDECLARED instance property whose value EQUALS the parent cluster's value for the same
// key; `aliases` maps the few keys the two APIs spell differently. The parent's own property
// still carries detection, so no out-of-band change is hidden — and an instance value that
// DIVERGES from the cluster (its own maintenance window, its single AZ) still surfaces.
// Keyed by the CHILD resource type. `parentType` is the cluster resource type whose live model
// the child echoes — `buildClusterEchoModels` (gather.ts / corpus record.ts) reads this to know
// which resources to harvest a parent model from, so adding an entry here wires the live path too
// (do NOT re-hardcode the type list in gather). `parentIdKey` is the child's declared property that
// Refs the parent's physical id; `aliases` maps a child prop name to the differently-spelled parent
// prop name.
export const CLUSTER_ECHO_CHILD: Record<
  string,
  { parentType: string; parentIdKey: string; aliases: Record<string, string> }
> = {
  'AWS::RDS::DBInstance': {
    parentType: 'AWS::RDS::DBCluster',
    parentIdKey: 'DBClusterIdentifier',
    // The two APIs spell a few shared settings differently: an instance's VPCSecurityGroups
    // is the cluster's VpcSecurityGroupIds; its EnablePerformanceInsights is the cluster's
    // PerformanceInsightsEnabled (Aurora manages PI cluster-wide, so the instance mirrors it).
    aliases: {
      VPCSecurityGroups: 'VpcSecurityGroupIds',
      EnablePerformanceInsights: 'PerformanceInsightsEnabled',
    },
  },
  // A Neptune DBInstance echoes its parent DBCluster's cluster-level DBSubnetGroupName — the
  // CDK instance never declares it (only DBClusterIdentifier + DBInstanceClass), so it floods a
  // first run as undeclared inventory that merely mirrors the cluster's declared value (#980).
  // Same shape as the Aurora echo above; Neptune's instance/cluster APIs spell the shared keys
  // identically, so no aliases are needed. Equality-gated against the parent's live model, so an
  // instance moved to a DIFFERENT subnet group still surfaces.
  'AWS::Neptune::DBInstance': {
    parentType: 'AWS::Neptune::DBCluster',
    parentIdKey: 'DBClusterIdentifier',
    aliases: {},
  },
};

const isKeyValueEntry = (t: unknown): t is { Key: string; Value: unknown } =>
  !!t &&
  typeof t === 'object' &&
  typeof (t as { Key?: unknown }).Key === 'string' &&
  'Value' in (t as object);

// Parent resources whose live model REFLECTS their separately-managed child resources
// as an inline aggregate property (e.g. an SNS Topic's `Subscription` list mirrors every
// AWS::SNS::Subscription pointing at it, including ones created out of band). cdkrd
// already tracks those children independently — declared ones as their own resources,
// out-of-band ones via the `added` enumerator (read/child-enumerators.ts) — so comparing
// the reflection too would DOUBLE-REPORT one subscription as both a `Topic.Subscription`
// undeclared drift AND an `added` Subscription resource. Drop the live reflection so the
// child is reported ONCE (as the resource). Only when the template does NOT declare the
// property inline: a stack that genuinely uses inline subscriptions keeps the compare
// (fail-open — never hide a declared value). Same idea as the sibling-IAM-policy drop.
const REFLECTED_CHILD_PROPS: Record<string, string> = {
  'AWS::SNS::Topic': 'Subscription',
};

// AWS::Events::EventBus reflects its RESOURCE POLICY — set by the declared sibling
// AWS::Events::EventBusPolicy resources that target it — as an undeclared `Policy`
// property (an IAM policy document `{Version, Statement:[...]}`) on the bus's live
// model. Each sibling EventBusPolicy's `StatementId` becomes a statement `Sid`. The
// sibling policies are tracked + compared as their OWN resources (they read fine via
// Cloud Control), so leaving the aggregated policy on the bus double-reports every
// statement AND surfaces a first-run [Potential Drift] on every custom bus that carries
// a policy — the standard cross-account eventing setup (#699).
//
// The fix is STATEMENT-LEVEL subtraction (mirroring subtractSiblingSgRules): subtract
// from the bus's live `Policy.Statement[]` the statements owned by a declared sibling
// EventBusPolicy (match by `Sid` == `StatementId`, or by resolved content), leaving any
// out-of-band statement (matching NO sibling) to still surface — so a directly-injected
// bus statement is NOT blinded (the whole-prop drop would have silenced it). The sibling
// statements are resolved from the full desired set in gather.ts (buildSiblingEventBusPolicies)
// and threaded through opts.siblingEventBusPolicies, keyed by the bus's identifier. Fail-open:
// an inline-declared `Policy` (a raw bus that pins the whole policy inline — not the standard
// CDK shape) is compared normally (the subtraction is skipped when Policy is declared).
const EVENT_BUS_TYPE = 'AWS::Events::EventBus';
const EVENT_BUS_POLICY_PROP = 'Policy';

// Remove from a bus's live `Policy.Statement[]` each statement owned by a declared sibling
// EventBusPolicy. A sibling matches a live statement when their `Sid`s are equal (the
// StatementId AWS reflects as the Sid) OR, when neither has a resolvable Sid, when the live
// statement is a SUPERSET of the sibling's resolved fields (AWS canonicalizes/injects extras
// the sibling never declared, so an exact equality compare would miss). One removal per sibling
// preserves a legitimately duplicated statement. If `Statement` empties, the whole `Policy`
// prop is dropped (empty == absent — don't introduce a []-vs-absent FP); a remaining
// out-of-band statement stays and surfaces.
function subtractSiblingEventBusStatements(
  live: Record<string, unknown>,
  siblingStatements: unknown[]
): void {
  const policy = live[EVENT_BUS_POLICY_PROP];
  if (!policy || typeof policy !== 'object') return;
  const p = policy as Record<string, unknown>;
  const arr = p.Statement;
  if (!Array.isArray(arr) || siblingStatements.length === 0) return;
  for (const sib of siblingStatements) {
    if (!sib || typeof sib !== 'object') continue;
    const sub = sib as Record<string, unknown>;
    const sibSid = sub.Sid;
    const i = arr.findIndex((el) => {
      if (el === null || typeof el !== 'object') return false;
      const e = el as Record<string, unknown>;
      // Prefer a Sid match (the StatementId AWS stamps onto the reflected statement).
      if (typeof sibSid === 'string' && sibSid) return e.Sid === sibSid;
      // No usable Sid: match when the live element is a SUPERSET of the sibling's fields
      // (skipping any UNRESOLVED sibling field, which cannot block the match).
      return Object.entries(sub).every(([k, v]) => v === UNRESOLVED || deepEqual(e[k], v));
    });
    if (i >= 0) arr.splice(i, 1);
  }
  if (arr.length === 0) delete live[EVENT_BUS_POLICY_PROP]; // empty == absent; no []-vs-absent FP
}

// IAM principal types whose inline live `Policies` can be sibling-managed by a separate
// AWS::IAM::Policy resource (the CDK `<Principal>DefaultPolicy` pattern). Used for the
// revert-hazard guard when the sibling PolicyName was UNRESOLVED (see below).
const IAM_PRINCIPAL_POLICY_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::IAM::Group',
]);

// AWS::EC2::SecurityGroup reflects, in its live SecurityGroupIngress / SecurityGroupEgress
// arrays, the rules declared by SIBLING standalone AWS::EC2::SecurityGroupIngress /
// ::SecurityGroupEgress resources that target it. CDK emits such a standalone rule resource
// whenever a rule references a token it cannot safely inline — a self/peer SG reference, a
// prefix list, an imported SG (`addIngressRule(otherSg, …)`, `Peer.prefixList(…)`, self-ref).
// Those sibling rules are tracked + compared as their OWN resources, so leaving them in the
// SG's live arrays double-counts them: the SG's DECLARED arrays hold only the INLINE rules, so
// every sibling-reflected live rule reads as a false declared drift (a very common shape — a
// self-referencing SG rule is the canonical ALB↔ASG / intra-cluster pattern). The fix mirrors
// REFLECTED_CHILD_PROPS, but a SUBSET not the whole property: subtract each sibling-declared
// rule from the live array, leaving the inline-declared rules (and any out-of-band rule, which
// matches no sibling) to compare normally.
const SG_RULE_REFLECTION: Record<string, 'ingress' | 'egress'> = {
  SecurityGroupIngress: 'ingress',
  SecurityGroupEgress: 'egress',
};

// Match one sibling-declared rule field against the live element's value. The exact
// deepEqual match is tried first (preserves every existing case), then two tolerances:
//   - typed<->string scalar coercion: a rule port declared as `Fn::GetAtt <Cluster>.
//     Endpoint.Port` resolves to the STRING "3306" (the DBCluster's live Endpoint.Port is
//     a string), while the SG's reflected live rule carries the NUMBER 3306, so a strict
//     deepEqual false-flags the whole declared ingress rule as undeclared drift on every
//     CDK Aurora stack (`cluster.connections.allowFrom(...)` is the canonical shape).
//   - UNRESOLVED wildcard: a declared field the intrinsic resolver could not evaluate is
//     unknowable, so it must not BLOCK the match — the CidrIp/protocol/description identity
//     still gates the subtraction. Consistent with the rest of the pipeline, which SKIPS an
//     unresolved declared value rather than false-drifting on it.
function siblingRuleFieldMatches(liveVal: unknown, sibVal: unknown): boolean {
  if (sibVal === UNRESOLVED) return true;
  return deepEqual(liveVal, sibVal) || isStringlyEqualScalar(liveVal, sibVal);
}

// Remove from `arr` the first element each sibling rule is a SUBSET of (every sibling key
// matches the live element's — the live element carries AWS-injected extras the sibling
// resource never declared, e.g. SourceSecurityGroupOwnerId on a self/peer-ref rule, so an
// exact equality compare would miss the match). One removal per sibling rule preserves a
// duplicate inline rule that legitimately repeats the shape.
function subtractSiblingSgRules(
  live: Record<string, unknown>,
  prop: string,
  siblingRules: unknown[]
): void {
  const arr = live[prop];
  if (!Array.isArray(arr) || siblingRules.length === 0) return;
  for (const rule of siblingRules) {
    if (!rule || typeof rule !== 'object') continue;
    const sub = rule as Record<string, unknown>;
    const i = arr.findIndex(
      (el) =>
        el !== null &&
        typeof el === 'object' &&
        Object.entries(sub).every(([k, v]) =>
          siblingRuleFieldMatches((el as Record<string, unknown>)[k], v)
        )
    );
    if (i >= 0) arr.splice(i, 1);
  }
  if (arr.length === 0) delete live[prop]; // empty array == absent; don't introduce a []-vs-absent FP
}

// An IAM Role/User/Group reflects, in its live `ManagedPolicyArns` (a ListAttached*Policies
// UNION), the ARNs of SIBLING AWS::IAM::ManagedPolicy resources that declare `Roles`/`Users`/
// `Groups` pointing back at it — a policy the principal never declared in its OWN
// `ManagedPolicyArns`. Because the principal compares `ManagedPolicyArns` (an ordinary array when
// it declares only its own ARNs), the sibling ARN reads as a DECLARED-tier drift that survives
// `record`, and a whole-array revert would DETACH the sibling-managed policy (#698). The sibling
// ManagedPolicy is tracked + compared as its own resource, so subtract its ARN (/name) from the
// principal's reflected live list. Match the live entry against the sibling value by exact equality
// OR by ARN-tail == name (the sibling was resolved to a bare ManagedPolicyName while the live entry
// is a full ARN, or vice versa). One removal per sibling. Any live ARN matching NO sibling — a
// genuinely out-of-band attachment — stays and surfaces. Fail-open: an unmatched sibling is a no-op.
const IAM_ATTACHMENT_REFLECTION_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::IAM::Group',
]);
const MANAGED_POLICY_ARNS_PROP = 'ManagedPolicyArns';

// True when a live `ManagedPolicyArns` entry denotes the same managed policy as a sibling value.
// Exact match first; then tolerate the ARN-vs-name mismatch (the sibling was keyed by a bare
// ManagedPolicyName, the live read returns the full ARN) by comparing an ARN's policy-name tail
// (everything after the last `/`) — either side may be the ARN.
function managedPolicyRefMatches(liveVal: unknown, sibVal: unknown): boolean {
  if (typeof liveVal !== 'string' || typeof sibVal !== 'string') return false;
  if (liveVal === sibVal) return true;
  const tail = (s: string): string => (s.startsWith('arn:') ? (s.split('/').pop() ?? s) : s);
  return tail(liveVal) === tail(sibVal);
}

// Remove from a principal's live `ManagedPolicyArns` each ARN attached by a declared sibling
// ManagedPolicy. Only the principal's OWN declared ARNs (and any out-of-band ARN matching no
// sibling) remain, so the sibling attachment is neither a declared FP nor a revert-detach hazard.
function subtractSiblingManagedPolicyArns(
  live: Record<string, unknown>,
  siblingArns: string[]
): void {
  const arr = live[MANAGED_POLICY_ARNS_PROP];
  if (!Array.isArray(arr) || siblingArns.length === 0) return;
  for (const sib of siblingArns) {
    const i = arr.findIndex((el) => managedPolicyRefMatches(el, sib));
    if (i >= 0) arr.splice(i, 1);
  }
  if (arr.length === 0) delete live[MANAGED_POLICY_ARNS_PROP]; // empty == absent; no []-vs-absent FP
}

// An IAM User reflects, in an undeclared live `Groups`, the group memberships added by SIBLING
// AWS::IAM::UserToGroupAddition resources — a value the user never declared, verified nowhere else
// (the addition resource is a CC-gap `skipped` type). Subtract each sibling-added group so it is
// not a first-run undeclared FP; a group added purely out of band (matching no sibling) stays and
// surfaces. If `Groups` empties, drop it (empty == absent).
const USER_GROUPS_PROP = 'Groups';
function subtractSiblingUserGroups(live: Record<string, unknown>, siblingGroups: string[]): void {
  const arr = live[USER_GROUPS_PROP];
  if (!Array.isArray(arr) || siblingGroups.length === 0) return;
  for (const sib of siblingGroups) {
    const i = arr.findIndex((el) => el === sib);
    if (i >= 0) arr.splice(i, 1);
  }
  if (arr.length === 0) delete live[USER_GROUPS_PROP]; // empty == absent; no []-vs-absent FP
}

// An ASG's live `LifecycleHookSpecificationList` merges its INLINE-declared hooks with the hooks
// applied by SIBLING standalone AWS::AutoScaling::LifecycleHook resources — origin-indistinguishable.
// Remove each sibling-declared hook by its unique `LifecycleHookName` (AWS enforces per-ASG name
// uniqueness, so name IS identity), leaving the inline-declared hooks (compared normally) and any
// out-of-band hook (matching no sibling) to surface. If the list empties (a standalone-only ASG),
// drop it — empty == absent, so no []-vs-absent undeclared FP.
const LIFECYCLE_HOOK_SPEC_PROP = 'LifecycleHookSpecificationList';
function subtractSiblingLifecycleHooks(
  live: Record<string, unknown>,
  siblingHookNames: string[]
): void {
  const arr = live[LIFECYCLE_HOOK_SPEC_PROP];
  if (!Array.isArray(arr) || siblingHookNames.length === 0) return;
  for (const name of siblingHookNames) {
    const i = arr.findIndex(
      (el) =>
        el !== null &&
        typeof el === 'object' &&
        (el as Record<string, unknown>).LifecycleHookName === name
    );
    if (i >= 0) arr.splice(i, 1);
  }
  if (arr.length === 0) delete live[LIFECYCLE_HOOK_SPEC_PROP]; // empty == absent; no []-vs-absent FP
}

// Cloud Control returns an ALTERNATIVE representation of a declared value as a separate
// live-only field. Keyed resourceType -> { liveOnlyField: declaredSiblingField }: drop the
// live-only field when its declared sibling is present (the template already pins the value
// in the other form). AWS::EC2::Subnet is the case — declaring `AvailabilityZone`
// ("ap-northeast-1a") makes CC also echo the resolved `AvailabilityZoneId` ("apne1-az4"), a
// different form of the SAME AZ, on EVERY subnet. Symmetric, so declaring either form drops
// the other.
const CC_ALT_REPRESENTATION: Record<string, Record<string, string>> = {
  'AWS::EC2::Subnet': {
    AvailabilityZoneId: 'AvailabilityZone',
    AvailabilityZone: 'AvailabilityZoneId',
  },
  // An ALB reads back `SubnetMappings` (`[{SubnetId}]`) — the object-array echo of the
  // declared scalar `Subnets` list. Drop it when `Subnets` is declared so it is not
  // reported as a live-only property (the subnets ARE compared via `Subnets`).
  // #845: the mirror runs BOTH ways — an NLB declared with `SubnetMappings` reads back an
  // undeclared scalar `Subnets` list echoing the same SubnetIds. Add the symmetric rule so
  // that live-only `Subnets` is dropped when `SubnetMappings` is declared (the subnets ARE
  // compared via the declared `SubnetMappings`).
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    SubnetMappings: 'Subnets',
    Subnets: 'SubnetMappings',
  },
};

// #652/#643 SHAPE-MISMATCH SIBLING ECHO: a resource type offers two declarable shapes for
// the SAME data, and the live read materializes the OTHER (richer) shape than the one the
// user declared — echoing the declared values under a different sibling key, PLUS filling in
// the extra shape's service defaults. Unlike CC_ALT_REPRESENTATION (drop a live-only field
// on presence of its declared twin), the twin here is a whole OBJECT whose overlapping keys
// must be VERIFIED to echo the declared source (so a genuine out-of-band change to an
// overlapping value still surfaces) and whose extended-only leaves must FOLD as the service
// defaults they are (not surface). Keyed resourceType -> { twinKey: sourceKey }.
//   - AWS::KinesisFirehose::DeliveryStream: declaring the plain `S3DestinationConfiguration`
//     (writeOnly → readGap, the simplest / older-CDK / raw-CFn destination shape) makes AWS
//     materialize the destination as the richer `ExtendedS3DestinationConfiguration` twin —
//     mirroring BucketARN/BufferingHints/CompressionFormat/RoleARN and default-filling
//     EncryptionConfiguration (NoEncryption), CloudWatchLoggingOptions (off), S3BackupMode
//     (Disabled). A first `check` of every plain-S3 stream otherwise reported the whole twin
//     object as [Potential Drift] on a clean deploy (#652). The extended-only defaults already
//     fold via KNOWN_DEFAULT_PATHS (proven by the ExtendedS3-declared corpus case), so routing
//     the twin through the SAME nested descent used for a declared object — with a synthetic
//     declared side built from the echoed source keys — folds the echo AND surfaces any genuine
//     out-of-band leaf change (a re-targeted bucket, an enabled encryption, a changed
//     compression), preserving detection.
const SHAPE_ECHO_TWIN: Record<string, Record<string, string>> = {
  'AWS::KinesisFirehose::DeliveryStream': {
    ExtendedS3DestinationConfiguration: 'S3DestinationConfiguration',
  },
};

// True when every key present in BOTH the declared source and the live twin object echoes
// the declared value (deep-equal for scalars/arrays; recursive subset for nested objects, so
// the twin carrying extra service-injected sub-keys inside a shared block does not break the
// match — those extras fold in the descent). A single overlapping key that DIFFERS means the
// twin is NOT a clean echo (a genuine out-of-band change), so the caller must not fold it —
// return false and let the whole twin surface as detectable drift.
function twinOverlapEchoes(
  source: Record<string, unknown>,
  twin: Record<string, unknown>
): boolean {
  for (const [k, tv] of Object.entries(twin)) {
    if (!(k in source)) continue;
    const sv = source[k];
    if (isNestedObject(sv) && isNestedObject(tv)) {
      if (!twinOverlapEchoes(sv, tv)) return false;
    } else if (!deepEqual(sv, tv)) return false;
  }
  return true;
}

// #712 / #1305: apply an AWS::StepFunctions::StateMachine `DefinitionSubstitutions` map into a
// declared `DefinitionString`, mirroring how CloudFormation resolves `${token}` placeholders at
// deploy time (the live read echoes the substituted string). This is a SINGLE Fn::Sub-like pass:
// the ORIGINAL definition text is scanned once for `${key}` tokens and each is replaced with its
// substitution value — injected text is NEVER re-scanned (#1305). A per-key sequential
// split/join re-substituted a value that itself contained a literal `${otherKey}` and made the
// result depend on template key order; CloudFormation's provider resolves in one pass, so the
// live definition keeps that literal while the naive resolver mis-resolved the declared side into
// a permanent false declared drift (and a mis-resolved revert write).
//
// Each `${key}` whose `key` is a declared substitution with a scalar value is replaced (stringified
// with `String(value)`). A `${key}` whose key is NOT in the map, or whose value is null/object
// (Step Functions substitutions are scalar), is left VERBATIM — so a genuine out-of-band definition
// change still surfaces as declared drift.
export function applyDefinitionSubstitutions(
  definitionString: string,
  substitutions: Record<string, unknown>
): string {
  return definitionString.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    if (!(key in substitutions)) return match;
    const value = substitutions[key];
    if (value === null || typeof value === 'object') return match;
    return String(value);
  });
}

// Per-type attachment-list properties handled by tier rather than a positional compare.
// AWS::IAM::ManagedPolicy's `Roles`/`Users`/`Groups` name the principals a managed
// policy is attached to — but the same policy is commonly attached from SEVERAL places
// (a role's own `ManagedPolicyArns`, a separate AWS::IAM::Policy/attachment resource,
// another stack, the console), so the LIVE set is a UNION that legitimately exceeds any
// one stack's intent. A symmetric compare would false-DRIFT on every shared policy (the
// FP `cdk drift` raises). So each member is tiered by WHO declared it:
//   - a DECLARED member MISSING from live -> declared drift (an out-of-band DETACH —
//     security-relevant: a privilege the stack intends was removed). Revertable
//     (re-attach the one member). The real FN the old "don't compare attachment lists"
//     boundary missed.
//   - a live member NOT declared          -> UNDECLARED inventory (recordable), NOT a
//     positional FP — the SAME treatment every other undeclared property + identity-
//     keyed subset array (ELB attribute bags, Cognito Schema) gets. So a known union
//     member is folded/recordable on a first run, and a NEW unexpected attachment
//     (a console/rogue grant of the policy's permissions to another principal) then
//     surfaces as drift vs the recorded baseline — detection cdk drift only matches by
//     ALSO false-drifting every legitimate union member. record-only (we never auto-
//     detach a member another owner added; --remove-unrecorded is the explicit opt-in).
// Catches BOTH a removed declared attachment and an added unexpected one, without the
// symmetric-compare false drift.
const IAM_ATTACHMENT_SUBSET: Record<string, ReadonlySet<string>> = {
  'AWS::IAM::ManagedPolicy': new Set(['Roles', 'Users', 'Groups']),
};

// #493: identity-keyed object-array SUBSET folds where the identity is a COMPOSITE of
// several fields AND live entries carry extra service-injected fields the template never
// declares. This is a stricter cousin of noise.ts NAME_VALUE_SUBSET_PATHS (RDS OptionGroup
// #480/#485) — that helper folds only PURE `{name,value}` pairs keyed by a single field, so
// it disqualifies (returns null) the moment an element carries any other key. Elastic
// Beanstalk's ConfigurationTemplate `OptionSettings` needs the composite variant:
//   - the template declares a SUBSET (~3 entries); once the composite-identifier adapter
//     (router.ts) makes the template CC-readable, CC returns the FULLY RESOLVED set (~58
//     entries) the service default-fills — a whole-array `declared` FP on every fresh deploy;
//   - each entry's identity is `Namespace` + `OptionName` together (neither alone is unique);
//   - live entries carry an extra `ResourceName` field the template never declares, which is
//     STRIPPED before the value compare (it is not part of the declared intent).
// When every declared entry is present in live with an equal value (declared ⊆ live), the
// whole-array `declared` diff is suppressed and the live-only (service-filled) entries surface
// as nested undeclared inventory (recorded; a later change still surfaces). A genuine declared
// entry change (missing key or differing value) returns null and the finding is kept.
interface CompositeSubsetSpec {
  re: RegExp;
  keyFields: string[];
  ignoreFields: ReadonlySet<string>;
  // Optional per-entry tier for the live-only (service-filled) extras. Given the entry and the
  // full live array, return 'atDefault' when the entry is at its AWS first-run default (folds,
  // invariant) or 'undeclared' otherwise (surfaces — a change away from the default). Absent →
  // every live-only entry is 'undeclared' (recorded inventory; a later change still surfaces).
  entryTier?: (entry: Record<string, unknown>, liveArray: unknown) => 'atDefault' | 'undeclared';
}
// AWS (both an EB ConfigurationTemplate and an Environment) materializes the FULL option set
// from the declared subset; fold each service-filled extra to its first-run default (equality-
// gate / derive-from-EnvironmentType / value-independent — see ebOptionSettingTier), so a clean
// template / environment shows zero potential drift. The Environment reads its OptionSettings
// back via the SDK_SUPPLEMENTS DescribeConfigurationSettings reader (writeOnly-but-readable).
const ebOptionSettingsEntryTier: NonNullable<CompositeSubsetSpec['entryTier']> = (
  entry,
  liveArray
) => {
  const arr = Array.isArray(liveArray) ? (liveArray as Record<string, unknown>[]) : [];
  const envEntry = arr.find((e) => e && e.OptionName === 'EnvironmentType');
  const envType = typeof envEntry?.Value === 'string' ? envEntry.Value : 'LoadBalanced';
  // #893: expose the sibling option lookup so a derived default (InstanceType = the first
  // element of the InstanceTypes option) can be computed and equality-gated.
  const siblingOption = (ns: string, opt: string): unknown =>
    arr.find((e) => e && e.Namespace === ns && e.OptionName === opt)?.Value;
  return ebOptionSettingTier(
    entry.Namespace,
    entry.OptionName,
    entry.Value,
    envType,
    siblingOption
  );
};
const ebOptionSettingsSubsetSpec: CompositeSubsetSpec = {
  re: /(^|\.)OptionSettings$/,
  keyFields: ['Namespace', 'OptionName'],
  ignoreFields: new Set(['ResourceName']),
  entryTier: ebOptionSettingsEntryTier,
};
const COMPOSITE_KEY_SUBSET_PATHS: Record<string, CompositeSubsetSpec> = {
  'AWS::ElasticBeanstalk::ConfigurationTemplate': ebOptionSettingsSubsetSpec,
  'AWS::ElasticBeanstalk::Environment': ebOptionSettingsSubsetSpec,
};

// Align a declared object array to a live one BY a composite identity key, ignoring the
// spec's live-only fields in the value compare. Returns the live-only entries (server-
// injected / out-of-band entries the template never declared) when every DECLARED entry is
// present in live and deep-equal on its declared (non-ignored) fields (declared ⊆ live,
// reorder-insensitive). Returns null when a declared entry is MISSING from live or a declared
// field differs (a genuine declared drift the caller must keep), or when either side is not a
// pure object array or an element is missing a key field (disqualify rather than risk muting).
function alignCompositeKeySubset(
  declared: unknown,
  live: unknown,
  spec: CompositeSubsetSpec
): unknown[] | null {
  if (!Array.isArray(declared) || !Array.isArray(live)) return null;
  const keyOf = (e: unknown): string | null => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const r = e as Record<string, unknown>;
    const parts: string[] = [];
    for (const f of spec.keyFields) {
      if (typeof r[f] !== 'string') return null;
      parts.push(r[f] as string);
    }
    return JSON.stringify(parts);
  };
  // A declared entry deep-equals a live entry once BOTH sides drop the ignored (live-only)
  // fields — the declared side never carries them, but strip symmetrically to be safe.
  const stripIgnored = (e: Record<string, unknown>): Record<string, unknown> => {
    if (spec.ignoreFields.size === 0) return e;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) if (!spec.ignoreFields.has(k)) out[k] = v;
    return out;
  };
  const lm = new Map<string, unknown>();
  for (const e of live) {
    const k = keyOf(e);
    if (k === null) return null;
    lm.set(k, e);
  }
  const declaredKeys = new Set<string>();
  for (const d of declared) {
    const k = keyOf(d);
    if (k === null || !lm.has(k)) return null;
    if (
      !deepEqual(
        stripIgnored(d as Record<string, unknown>),
        stripIgnored(lm.get(k) as Record<string, unknown>)
      )
    )
      return null;
    declaredKeys.add(k);
  }
  return live.filter((e) => {
    const k = keyOf(e);
    return k !== null && !declaredKeys.has(k);
  });
}

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

// #627: a DynamoDB table's/GSI's undeclared WarmThroughput echoes its EFFECTIVE capacity —
// the {12000,4000} on-demand constant AWS seeds when there is no ProvisionedThroughput, or the
// sibling ProvisionedThroughput's read/write units (as warm units) on a provisioned table/GSI.
// So it is a DERIVED default keyed on the sibling ProvisionedThroughput, unifying both cases:
// compute it and equality-gate, so an out-of-band warm-throughput change (which auto-ratchets
// upward under load and never decreases) still surfaces — the same trade-off the type accepts.
const DDB_TABLE_TYPES = new Set(['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']);
function warmThroughputDefault(provisionedThroughput: unknown): Record<string, number> {
  if (
    isNestedObject(provisionedThroughput) &&
    typeof provisionedThroughput.ReadCapacityUnits === 'number' &&
    typeof provisionedThroughput.WriteCapacityUnits === 'number'
  ) {
    return {
      ReadUnitsPerSecond: provisionedThroughput.ReadCapacityUnits,
      WriteUnitsPerSecond: provisionedThroughput.WriteCapacityUnits,
    };
  }
  return { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
}
// A GSI-nested WarmThroughput path (`GlobalSecondaryIndexes[<IndexName>].WarmThroughput`) that
// echoes THAT GSI's effective capacity. Resolves the GSI's own ProvisionedThroughput from the
// live model by IndexName so the derived default is per-GSI.
function dynamoGsiWarmThroughputAtDefault(
  resourceType: string,
  path: string,
  value: unknown,
  live: Record<string, unknown>
): boolean {
  if (!DDB_TABLE_TYPES.has(resourceType)) return false;
  const m = /^GlobalSecondaryIndexes\[(.*)\]\.WarmThroughput$/.exec(path);
  if (m === null || !Array.isArray(live.GlobalSecondaryIndexes)) return false;
  const gsi = (live.GlobalSecondaryIndexes as unknown[]).find(
    (g) => isNestedObject(g) && g.IndexName === m[1]
  );
  if (!isNestedObject(gsi)) return false;
  return deepEqual(value, warmThroughputDefault(gsi.ProvisionedThroughput));
}

// #705: a Classic ELB (ElasticLoadBalancing::LoadBalancer) with an HTTPS/SSL listener but no
// declared SSL policy reads back an AWS-assigned SSL negotiation policy. The whole `Policies`
// array was folded value-independently, which made an out-of-band SSL-policy DOWNGRADE (an older
// predefined policy, a custom SSLv3-enabled one) OR any added policy INVISIBLE — a security FN.
// Fold atDefault ONLY when EVERY element is the AWS default SSL negotiation policy, identified by
// its stable `PolicyName` (the ~100 cipher `Attributes` are a derived function of the name and
// move over time, so they are ignored — the name is the pinnable identity, exactly like a
// KNOWN_DEFAULTS constant; a future AWS default bump surfaces as a fold-gap to add here). Any
// element with a different PolicyName, a non-SSL policy type, or any additional policy makes the
// whole property surface (equality-gated — out-of-band detection restored).
const CLB_DEFAULT_SSL_POLICY_NAME = 'ELBSecurityPolicy-2016-08';
function clbDefaultSslPoliciesAtDefault(
  resourceType: string,
  key: string,
  value: unknown
): boolean {
  if (resourceType !== 'AWS::ElasticLoadBalancing::LoadBalancer' || key !== 'Policies')
    return false;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (el) =>
      isNestedObject(el) &&
      el['PolicyType'] === 'SSLNegotiationPolicyType' &&
      el['PolicyName'] === CLB_DEFAULT_SSL_POLICY_NAME
  );
}

// A CloudFormation AUTO-GENERATED physical name. When a resource declares no explicit name,
// CFn mints `<stackName>-<logicalId>-<random>` (the stack name is the FIRST segment of the
// CDK construct path). DELIBERATELY strict — it must start with this stack's name AND end
// with CFn's ~12+ char alphanumeric random suffix — so a user-chosen name is not folded away
// (that would hide a real undeclared value, defeating the differentiator). For SHORT-name
// resource types (an ELBv2 load balancer / target group name is capped at 32 chars) CFn
// TRUNCATES both segments — stack `CdkRealDriftIntegIotVpces` + logical id `NlbBC…` mints
// `CdkRea-NlbBC-Rz5FCsQXIO7E` — so the full-prefix test misses and every auto-named
// NLB/ALB/target group was first-run noise (observed live). The truncated branch stays
// tightly gated: BOTH halves must be prefixes of this stack's name and this resource's own
// logical id, with the stack half a STRICT prefix (truncation actually happened — the
// untruncated form is the branch above) — a user-chosen name realistically never matches
// all of that. Pure.
const CFN_RANDOM_SUFFIX = /-[0-9A-Za-z]{12,}$/;

// #503: return a copy of a parsed JSON-string LIVE value with service-injected default
// members subtracted, so the JSON_STRING_PROPS structural compare does not false-flag them.
// A key is dropped from a live object only when it is a listed default, the DECLARED side
// omits it, AND the live value equals the default (equality-gated — a member the template
// set to a non-default value is kept and still compares). Runs per element when the parsed
// value is a top-level array, at the root when it is an object; leaves anything else as-is.
function stripInjectedJsonStringDefaults(
  declared: unknown,
  live: unknown,
  defaults: Record<string, unknown>
): unknown {
  const stripObject = (d: unknown, l: unknown): unknown => {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) return l;
    const dObj =
      d !== null && typeof d === 'object' && !Array.isArray(d)
        ? (d as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(l as Record<string, unknown>)) {
      if (key in defaults && !(key in dObj) && deepEqual(val, defaults[key])) continue;
      out[key] = val;
    }
    return out;
  };
  if (Array.isArray(live)) {
    const dArr = Array.isArray(declared) ? declared : [];
    return live.map((l, i) => stripObject(dArr[i], l));
  }
  return stripObject(declared, live);
}
function isCfnGeneratedName(
  value: unknown,
  constructPath: string | undefined,
  physicalId: string | undefined,
  logicalId?: string
): boolean {
  // The bare physical-id echo (value === physicalId) is a STRUCTURAL drop handled separately
  // — never fold it into a `generated` finding here, or a resource whose physical id IS its
  // CFn-generated name gains a phantom finding.
  if (typeof value !== 'string' || value === physicalId) return false;
  // A bare LOGICAL-ID echo: for some types CloudFormation mints an auto-generated physical
  // name equal to the resource's LOGICAL ID verbatim — no `<stack>-` prefix, no extra random
  // suffix beyond the CDK hash already baked into the logical id (a BucketDeployment's
  // AwsCliLayer LayerName reads back "CaDeployAwsCliLayer58606CDE", its own logical id; #509).
  // The strict `<stack>-…-<suffix>` shapes below never match that form. A CDK logical id
  // already carries an 8-hex-char construct hash, so a user-chosen value coinciding is
  // effectively impossible — fold it. (aws-s3-deployment is a very common construct.)
  if (logicalId && value === logicalId) return true;
  // The full CFn form `<stackName>-<logicalId>-<random>` anchored on the LOGICAL ID alone — the
  // logical id is a WHOLE segment sitting between a `<prefix>-` and CFn's random suffix. This does
  // NOT need the construct path: an implicitly-created resource (an RDS cluster's / DBProxy's
  // auto-made AWS::EC2::SecurityGroup) can lose its `aws:cdk:path` metadata in the deployed
  // template, so `constructPath` is undefined and the stack-prefix branches below never run — yet
  // its undeclared GroupName still reads back `<stack>-<logicalId>-<random>` and floods the first
  // run (#888). Requires a NON-EMPTY prefix segment before the logical id (`<prefix>-<logicalId>-
  // <random>`, never a bare `<logicalId>-<random>` — that no-prefix form is over-broad for short
  // raw-CFn logical ids, e.g. a WAFv2 WebACL "Edge-<random>", and stays scoped per type+path via
  // GENERATED_LOGICALID_PREFIX_PATHS). A CDK logical id carries an 8-hex construct hash, so a
  // user-chosen name ending in `-<thisLogicalId>-<random>` is effectively impossible — value-
  // DEPENDENT, so a real user name (e.g. "my-custom-sg") still surfaces. Runs before the
  // constructPath gate so it folds regardless of whether the path survived.
  if (logicalId && CFN_RANDOM_SUFFIX.test(value)) {
    const base = value.replace(CFN_RANDOM_SUFFIX, '');
    if (base.length > logicalId.length && base.endsWith(`-${logicalId}`)) return true;
  }
  if (!constructPath) return false;
  const stackName = constructPath.split('/')[0];
  if (!stackName || !CFN_RANDOM_SUFFIX.test(value)) return false;
  if (value.startsWith(`${stackName}-`)) return true;
  if (!logicalId) return false;
  // Truncated short-name form: `<stackPrefix>-<logicalIdPrefix>-<random>`. Logical ids are
  // alphanumeric (never '-'), so the LAST '-' in the de-suffixed base splits the two halves
  // even when the stack name itself contains dashes.
  const base = value.replace(CFN_RANDOM_SUFFIX, '');
  const sep = base.lastIndexOf('-');
  if (sep <= 0) return false;
  const stackPart = base.slice(0, sep);
  const logicalPart = base.slice(sep + 1);
  return (
    stackPart.length < stackName.length &&
    stackName.startsWith(stackPart) &&
    logicalPart.length > 0 &&
    logicalId.startsWith(logicalPart)
  );
}

// A live-only OBJECT that is a SELF-IDENTITY ECHO WRAPPER: some CC read handlers
// (AWS::Logs::DeliveryDestination's DeliveryDestinationPolicy) return
// `{ <IdentityField>: <own physical id>, <Payload>: {} }` when the payload was never
// set — semantically "nothing configured", but the id echo defeats the plain deep
// trivially-empty drop. Ignore FIRST-LEVEL entries equal to the resource's own
// physical id (at least one must match, so ordinary objects never take this path),
// then apply the same deep trivially-empty test. A REAL payload (an actually
// attached policy) is not trivially empty and still surfaces. Pure.
function isSelfEchoTrivialEmpty(v: unknown, physicalId: string | undefined): boolean {
  if (physicalId === undefined || v === null || typeof v !== 'object' || Array.isArray(v))
    return false;
  const entries = Object.entries(v as Record<string, unknown>);
  const rest = entries.filter(([, val]) => val !== physicalId);
  return rest.length < entries.length && rest.every(([, val]) => isTrivialEmpty(val));
}

// #978: AWS::RDS::OptionGroup default-fill — configuring an option (e.g. MARIADB_AUDIT_PLUGIN,
// Oracle NATIVE_NETWORK_ENCRYPTION, SQLServer SQLSERVER_AUDIT) makes RDS materialize EVERY plugin
// setting the template did not declare, in two shapes:
//   1. value-bearing AWS defaults — SERVER_AUDIT=FORCE_PLUS_PERMANENT,
//      SQLNET.ENCRYPTION_CLIENT=REQUESTED, ... (the value equals the option's catalog default), and
//   2. value-less `{Name}`-only husks — a listed-but-unset setting (no `Value` member).
// Both are service-materialized first-run defaults, never user intent, so each folds `atDefault`
// (the undeclared-tier twin of the closed #480 declared-tier fold). Equality-gated so out-of-band
// detection survives: a husk that GAINS a Value, or a default whose Value CHANGES, no longer
// matches and surfaces undeclared.
//
// The value-bearing defaults are (engine, version, option, setting)-specific, so instead of
// PINNING constants (which rot over time — the #1072 class — and collide across options, e.g.
// SQLServer SSAS.MAX_MEMORY=45 vs SSRS.MAX_MEMORY=30) gather RESOLVES them LIVE from
// `describe-option-group-options` into `opts.rdsOptionSettingDefaults[physicalId][option]`
// (`{settingName: DefaultValue|null}`) — the same "what AWS assigns undeclared == the option's
// catalog default" fact CFn drift detection leans on. Empirically the catalog DefaultValue equals
// the value RDS materializes for an unset setting (verified live: mariadb audit + oracle
// native-network-encryption). Keyed by (physicalId, OptionName, SettingName), so it is
// collision-free across options and never rots (re-read every run); when the catalog is absent
// (read denied / offline replay without it) the value-bearing fold simply does not apply
// (fail-open — the setting surfaces undeclared, the pre-#978 behavior), while husks still fold.

// A `{<idField>: X}` element whose ONLY non-trivial member is its identity field — an
// identity-only husk (the #648 `Targets[].AvailabilityZone` in-element husk class). Carries no
// configuration, so it is a listed-but-unset default placeholder; a real value under any other
// member makes it non-trivial and it stops folding.
function isIdentityOnlyHusk(el: Record<string, unknown>, idField: string): boolean {
  return Object.entries(el).every(([k, v]) => k === idField || isTrivialEmpty(v));
}

// The gather-resolved catalog default for `settingName` under the OptionConfiguration at `path`'s
// array index. Returns the DefaultValue string, `null` for a catalog husk, or `undefined` when
// unresolvable (no catalog, unknown option/setting) — in which case the value-bearing fold does
// not apply.
//
// `OptionConfigurations` is `insertionOrder:false`, so classify sorts BOTH sides by canonical JSON
// before the positional diff — `path`'s array index is the SORTED index, NOT the raw template
// index. The owning option NAME must therefore be resolved from the array the diff index actually
// refers to: the diff was computed over the sorted `liveVal`, whose element at the diff index is
// order-aligned with `path` and carries the same `OptionName` as its declared counterpart. Reading
// the name from the RAW, unsorted declared model would pick the WRONG option whenever raw order ≠
// sorted order (a multi-option group whose template order differs from canonical sort), silently
// dropping the fold and surfacing every catalog default as first-run undeclared drift (#1318).
function rdsMaterializedDefault(
  catalog: Record<string, Record<string, Record<string, string | null>>> | undefined,
  physicalId: string | undefined,
  aligned: unknown,
  path: string,
  settingName: string
): string | null | undefined {
  if (!catalog || physicalId === undefined) return undefined;
  const m = /OptionConfigurations\.(\d+)\.OptionSettings$/.exec(path);
  if (!m) return undefined;
  const configs = Array.isArray(aligned) ? aligned : undefined;
  const optName = configs
    ? (configs[Number(m[1])] as { OptionName?: unknown } | undefined)?.OptionName
    : undefined;
  if (typeof optName !== 'string') return undefined;
  const perOption = catalog[physicalId]?.[optName];
  return perOption && settingName in perOption ? perOption[settingName] : undefined;
}

// A live-only policy DOCUMENT whose statements were ALL subtracted as AWS-managed
// (canonicalizePolicy drops the delivery.logs `AWSLogDelivery*` statements a service
// auto-attaches when vended logs are pointed at a log group — a CloudWatch Logs
// Delivery, an APS Workspace LoggingConfiguration, VPC flow logs; issue #462 item 2,
// APS instance per the #464 addendum). What survives is the bare policy-grammar
// shell `{Version, Statement: []}` — Version is a non-empty constant string, so the
// plain deep trivially-empty drop misses it and every vended-logs user saw one line
// of first-run noise on the LOG GROUP. The shell carries no inventory value; drop it
// as structural noise. Gated: `Statement` must be present and EMPTY (a doc with any
// surviving statement — a real out-of-band policy, a foreign principal, a user grant
// — is not a shell), and every other key must be the grammar boilerplate
// (Version/Id strings). Pure.
function isEmptyPolicyShell(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.Statement) || o.Statement.length > 0) return false;
  return Object.entries(o).every(
    ([k, val]) => k === 'Statement' || ((k === 'Version' || k === 'Id') && typeof val === 'string')
  );
}

// structuredClone rejects the UNRESOLVED Symbol a declared value may carry, so deep-clone
// the declared model symbol-safe (symbols/primitives pass through by reference/value). Used
// to clone the declared side before stripAsymmetricIdentityFields mutates it.
function cloneDeepWithSymbols(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneDeepWithSymbols);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = cloneDeepWithSymbols(val);
    return out;
  }
  return v;
}

// An IAM policy STATEMENT array (PolicyDocument.Statement, AssumeRolePolicyDocument
// .Statement, inline Policies[].PolicyDocument.Statement, …). Recognized by the
// `Effect` (Allow/Deny) key every statement carries — NOT by path, so it catches
// statements at any depth. Statements are identity-LESS (no Key/Id/AttributeName/
// IndexName), so the identity-keyed descent below skips them; this marker re-enables
// a SAFE (subset-match) descent for exactly this shape, leaving other identity-less
// arrays (SecurityGroup rules etc.) untouched.
const isPolicyStatementArray = (arr: unknown[]): boolean =>
  arr.length > 0 && arr.every((el) => isNestedObject(el) && 'Effect' in el);

// An IAM inline-policy WRAPPER array — `Policies: [{ PolicyName, PolicyDocument }]` on
// AWS::IAM::Role/User/Group, the dominant CDK inline-policy shape. The wrapper is
// identity-LESS (PolicyName is not a generic IDENTITY_FIELD) and its elements are NOT
// statements (no `Effect`), so neither descent above fires — leaving the wrapped
// PolicyDocument.Statement unreached and a live-only sub-key added to a wrapped statement
// (e.g. an out-of-band `Condition` narrowing/widening access) invisible, the same FN
// #151 fixed for TOP-LEVEL documents. Recognized by `PolicyDocument` so the descent can
// align by PolicyName and reach the statement subset-match for this shape too.
const isInlinePolicyArray = (arr: unknown[]): boolean =>
  arr.length > 0 && arr.every((el) => isNestedObject(el) && 'PolicyDocument' in el);

// A `{Key,Value}` tag list — the shape canonicalizeTagLists (normalize/noise.ts) SORTS on
// BOTH compare sides by its `Key` identity field, while the live side additionally has its
// `aws:*` tags stripped. A per-element VALUE change then diffs at a `Tags.<sortedIdx>.Value`
// path whose index is the SORTED+STRIPPED position — it does NOT map to the RAW live model
// (raw order, aws:* tags present) Cloud Control patches, so a sub-path patch lands on the
// WRONG element (silent corruption) or out of range (loud reject) (#750). The safe revert is
// a WHOLE-ARRAY `/Tags` write of the declared list (revert then re-attaches aws:* managed
// tags via tagPreservingOps), collapsed by the revert plan exactly like an UNORDERED_OBJECT_
// ARRAY. Recognized by the Key identity field + a Value on every element (a plain identity-
// keyed object array — CloudFront Origins, etc. — has no Value and is unaffected).
const isKeyValueTagList = (arr: unknown[]): boolean =>
  arr.length > 0 &&
  identityField(arr) === 'Key' &&
  arr.every((el) => isNestedObject(el) && 'Value' in el);

// True when every key of `sub` is present in `sup` with an equal value (objects
// recurse so a nested declared block must also be a subset; everything else is
// deep-equal). Used to align a declared policy statement to the live statement it is
// a subset of — robust to the statement re-sort canonicalization applies once a
// sub-key is added (so positional alignment would break) and to extra live-only keys.
function isPolicySubsetOf(sub: Record<string, unknown>, sup: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(sub)) {
    if (!(k in sup)) return false;
    const sv = sup[k];
    if (isNestedObject(v) && isNestedObject(sv)) {
      if (!isPolicySubsetOf(v, sv)) return false;
    } else if (!deepEqual(v, sv)) return false;
  }
  return true;
}

// True when an undeclared live value matches a known AWS default — for the `atDefault`
// fold (R86). A plain deepEqual is too strict for an OBJECT default whose sub-keys AWS
// reports inconsistently: an EDGE RestApi reads back EndpointConfiguration as
// `{Types:['EDGE']}` in some regions but `{IpAddressType:'ipv4',Types:['EDGE']}` in
// others, so a strict compare against the fuller KNOWN_DEFAULTS object fails on the
// omitted key and the whole undeclared object falls through as a false positive. Accept
// the live value when it deep-equals the default OR is a SUB-OBJECT of it: every key it
// carries matches the default and it carries no key absent from the default. Still
// equality-gated per overlapping key — a sub-key set to a non-default value
// (IpAddressType:'dualstack'), or an extra key the default doesn't list, breaks the
// match and surfaces as real drift. Scalars/arrays fall back to deepEqual. Exported for
// unit tests.
export function matchesKnownDefault(live: unknown, def: unknown): boolean {
  if (deepEqual(live, def)) return true;
  // SCALAR leaves fold through NUMERIC-string representation tolerance: a pinned default `1`
  // must match a live `"1"` when a provider echoes the value stringified (real: SQS returns
  // `"5"` for `5`, Budgets `"5.0"` for `5`). This only relaxes REPRESENTATION of
  // semantically-equal NUMBERS (`1` vs `"1"`); `1` vs `"2"` still differs, so no real drift
  // is hidden. Deliberately numeric-ONLY (not isStringlyEqualScalar's boolean<->string arm):
  // an S3 schema default `EventBridgeEnabled` stored as the STRING "true" must NOT fold a
  // live BOOLEAN true, which would hide a real user-enabled EventBridge config (#731).
  // Restricted to scalar leaves — the object/array subset tolerance below is untouched.
  if (!isNestedObject(live) && !isNestedObject(def)) return isNumericStringEqualScalar(live, def);
  if (!isNestedObject(live) || !isNestedObject(def)) return false;
  // Trivially-empty live sub-keys the default does NOT list carry no inventory value (a
  // schema-strip residue husk — RedshiftServerless Workgroup's echo attribute reads back an
  // `Endpoint` that is only `{VpcEndpoints:[{NetworkInterfaces:[{},{}]}]}` after leaf
  // readOnly-stripping, #491). Skip only those, so the object still matches a default that
  // lists only the meaningful sub-keys (its `PricePerformanceTarget`) without pinning the
  // per-deploy ENI shape. A key the default DOES list must still deep-equal it — so a
  // trivially-empty live value that is the OPPOSITE of a non-empty default (VpcLattice
  // SharingConfig `{enabled:false}` vs default `{enabled:true}`, #483) never vacuously folds.
  // RECURSE on nested-object values so the subset tolerance applies at every depth, not
  // just the top level: AWS grows nested default objects over time (e.g. an ECS Service's
  // DeploymentCircuitBreaker gained ResetOnHealthyTask + ThresholdConfiguration), so an
  // OLDER live echo carrying fewer sub-keys must still fold against the fuller pinned
  // default. Still equality-gated at every leaf — a sub-key set to a non-default value, or
  // an extra non-trivial key the default doesn't list at any level, breaks the match and
  // surfaces. (A strict deepEqual here folded only the exact recorded shape.)
  return Object.entries(live).every(([k, v]) =>
    k in def ? matchesKnownDefault(v, def[k]) : isTrivialEmpty(v)
  );
}

function collectNestedUndeclared(
  declaredVal: unknown,
  liveVal: unknown,
  path: string,
  emit: (path: string, value: unknown) => void,
  // Per-type override: nested object-arrays whose element identity is a NON-standard field
  // (not one of IDENTITY_FIELDS), keyed by the array's path with brackets stripped. Without
  // it those arrays are identity-LESS to the generic check below and the descent is skipped —
  // hiding a live-only sub-key added to a declared element (a silent FN). See
  // NESTED_ARRAY_IDENTITY.
  nestedArrayIdentity?: Record<string, string>,
  // True only when this map/property has NO declared twin at all (the #555 fully-undeclared
  // descend passes an empty `{}` sentinel). A DECLARED-empty `{}` (dv passed from the declared
  // loop) is NOT absent — its whole-map compare already owns any unsafe-key divergence, so the
  // path-unsafe emit below must fire on genuine ABSENCE, not zero-length (#1275).
  declaredAbsent = false
): void {
  if (Array.isArray(declaredVal) && Array.isArray(liveVal)) {
    if (declaredVal.length === 0 || liveVal.length === 0) return;
    // A registered identity field (e.g. ApiGateway Method Integration.IntegrationResponses
    // keyed by StatusCode) wins over the generic IDENTITY_FIELDS sniff; both sides share it.
    const regId = nestedArrayIdentity?.[path.replace(/\[[^\]]*\]/g, '')];
    const idf = regId ?? identityField(declaredVal);
    if (idf && (regId !== undefined || identityField(liveVal) === idf)) {
      const liveById = new Map<string, Record<string, unknown>>();
      for (const el of liveVal) if (isNestedObject(el)) liveById.set(String(el[idf]), el);
      for (const dEl of declaredVal) {
        if (!isNestedObject(dEl)) continue;
        const match = liveById.get(String(dEl[idf]));
        if (match)
          collectNestedUndeclared(
            dEl,
            match,
            `${path}[${String(dEl[idf])}]`,
            emit,
            nestedArrayIdentity
          );
      }
      return;
    }
    // IAM policy STATEMENT arrays are identity-less, so the descent above is skipped —
    // which hid a live-only sub-key ADDED to a declared statement out of band (e.g. a
    // `Condition` narrowing/widening access, or an extra `Principal`): the product's
    // core "a setting you never declared changed" promise failing on a security-
    // relevant resource. Re-enable the descent for THIS shape only, aligning each
    // declared statement to the live statement it is a SUBSET of (content match,
    // greedy 1:1) so the live-only sub-keys surface. A declared statement with no
    // superset match genuinely changed → left to the declared compare. Other identity-
    // less arrays stay undescended (no `Effect` marker), preserving their FP safety.
    if (isPolicyStatementArray(declaredVal) && isPolicyStatementArray(liveVal)) {
      const used = new Set<number>();
      declaredVal.forEach((dEl, di) => {
        if (!isNestedObject(dEl)) return;
        for (let i = 0; i < liveVal.length; i++) {
          if (used.has(i)) continue;
          const lEl = liveVal[i];
          if (isNestedObject(lEl) && isPolicySubsetOf(dEl, lEl)) {
            used.add(i);
            collectNestedUndeclared(dEl, lEl, `${path}[${di}]`, emit, nestedArrayIdentity);
            break;
          }
        }
      });
      return;
    }
    // IAM inline-policy wrappers (Role/User/Group `Policies[]`) are identity-less and
    // their elements aren't statements, so neither descent above reaches the wrapped
    // PolicyDocument.Statement. Align by PolicyName and recurse into each matched pair so
    // the statement subset-descent (above) is reached for this dominant CDK shape too.
    if (isInlinePolicyArray(declaredVal) && isInlinePolicyArray(liveVal)) {
      const liveByName = new Map<string, Record<string, unknown>>();
      for (const el of liveVal)
        if (isNestedObject(el) && typeof el.PolicyName === 'string')
          liveByName.set(el.PolicyName, el);
      for (const dEl of declaredVal) {
        if (!isNestedObject(dEl) || typeof dEl.PolicyName !== 'string') continue;
        const match = liveByName.get(dEl.PolicyName);
        if (match)
          collectNestedUndeclared(
            dEl,
            match,
            `${path}[${dEl.PolicyName}]`,
            emit,
            nestedArrayIdentity
          );
      }
    }
    return;
  }
  if (!isNestedObject(declaredVal) || !isNestedObject(liveVal)) return;
  // A free-form map (Glue Table `Parameters`, API Gateway Method `RequestParameters`,
  // map Tags, ECS `DockerLabels`, parameter-group entries) can hold live-only keys that
  // contain the path grammar's separators — an Athena `projection.enabled`, a
  // `method.request.querystring.x`, a `app.kubernetes.io/name` tag, a key with `[`/`]`.
  // Descending would build a child path like `Parameters.projection.enabled` that every
  // downstream consumer (`toPointer` for the revert JSON-pointer, the baseline
  // `topSegment`, the ignore-rule glob) RE-SPLITS on `.`/`[`, landing on the WRONG
  // location — a misdirected revert write and a silently ineffective ignore/baseline
  // rule. Mirror the declared-side guard (drift-calculator `hasPathUnsafeKey`): when any
  // key would corrupt the path, don't descend — emit the whole map at the current (safe)
  // path so the revert rewrites the map as a unit and the finding path carries no
  // ambiguous segment. But emit ONLY when the map is genuinely LIVE-ONLY (the declared
  // twin is empty): a DECLARED unsafe-key map (a Glue Table's `TableInput.Parameters`
  // with its `projection.*` keys, a SerdeInfo `field.delim`) is owned by the DECLARED
  // whole-map compare — drift-calculator's `hasPathUnsafeKey` guard emits it as ONE
  // declared drift when it differs (an out-of-band added/changed/removed key), and the
  // stringly-equal fold collapses the CDK typed-JSON vs AWS string coercion. Emitting it
  // here too false-flagged every declared dot-key map as first-run undeclared drift.
  if (Object.keys(liveVal).some((k) => PATH_UNSAFE_KEY.test(k))) {
    // Emit only when the map is genuinely LIVE-ONLY (no declared twin). A DECLARED-empty `{}`
    // (declaredAbsent === false, Object.keys length 0) is owned by the declared whole-map
    // compare; emitting here too double-reported it as declared + undeclared (#1275).
    if (declaredAbsent) emit(path, liveVal);
    return;
  }
  for (const [k, val] of Object.entries(liveVal)) {
    const childPath = `${path}.${k}`;
    if (k in declaredVal)
      collectNestedUndeclared(declaredVal[k], val, childPath, emit, nestedArrayIdentity);
    else emit(childPath, val);
  }
}

// A key that contains the path grammar's separators (`.`, `[`, `]`). Descending into
// such a key would produce a finding path that downstream consumers re-split into the
// wrong location — so a map holding one is emitted whole at its parent path. Mirrors
// drift-calculator's declared-side `PATH_UNSAFE_KEY` guard for the undeclared side.
const PATH_UNSAFE_KEY = /[.[\]]/;

// Bring a raw Cloud Control live model into the SAME canonical, noise-subtracted form
// classify's live side uses: strip AWS-managed fields + `aws:*` tags, reconcile OAI
// principals (no-op without a resolved map), run the shared canonicalization pipeline
// (policy docs + tag lists + id arrays), then drop schema readOnly + writeOnly paths.
// Factored out of `classifyResource` so the `added` tier (read/child-enumerators.ts,
// whole out-of-band resources with NO declared side to compare) can normalize the
// child's full model IDENTICALLY before record/compare — otherwise a volatile readOnly
// field (a timestamp, a revision id) would read as a false "changed since record" on
// every check. Mutates a fresh object (the canonicalize step clones), so liveRaw is
// untouched. Pure: no AWS calls.
// Sort a resource's per-type UNORDERED-SET properties into a canonical order, in place.
// canonicalizeForCompare is type-agnostic, so it can't apply these per-type opt-ins; the
// DECLARED loop sorts them for its compare, but the UNDECLARED loop (and the recorded
// baseline value + the `added` model) emitted them RAW — so a recorded SG ingress set or
// Cognito OAuth list, re-read by AWS in a different order, false-flagged as "changed since
// record" (baselineValueMatches re-canonicalizes without this step). Sorting them here, in
// the shared live-model normalizer, makes every downstream consumer see one stable order.
// Sort a scalar array (string/number/boolean multiset) into a stable canonical order.
// Non-scalar / non-array values are returned untouched, so a caller can apply this
// blindly to whatever it finds at a path. Order matches the DECLARED loop's
// `isEqualUnorderedScalarSet` comparison intent: same multiset, canonical order.
function sortScalarSet(v: unknown): unknown {
  if (
    Array.isArray(v) &&
    v.every((e) => typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean')
  )
    return [...v].sort((a, b) =>
      `${typeof a}:${String(a)}` < `${typeof b}:${String(b)}` ? -1 : 1
    );
  return v;
}

// Walk `model` along a dotted path TEMPLATE (segments separated by `.`) and apply
// `sort` to the array found at each matching leaf, IN PLACE. A `*` segment matches
// EVERY element of an array OR every value of a plain object at that position — the
// same wildcard the DECLARED loop normalizes numeric drift-path segments to before its
// `UNORDERED_ARRAY_PROPS` lookup (`Triggers.0.…Push.0.…Includes` → `Triggers.*.…Push.*.…`).
// A concrete segment descends into that object key. Anything that doesn't match the
// shape (a missing key, a scalar where an object/array is expected) is skipped, so an
// absent nested config is a no-op. Used for the nested/dotted UNORDERED_ARRAY_PROPS +
// schema `unorderedScalarPaths` entries the top-level loop cannot reach.
function sortScalarSetAtNestedPath(model: unknown, segs: readonly string[]): void {
  if (segs.length === 0 || model === null || typeof model !== 'object') return;
  const [head, ...rest] = segs;
  if (head === '*') {
    const children = Array.isArray(model) ? model : Object.values(model);
    for (const child of children) sortScalarSetAtNestedPath(child, rest);
    return;
  }
  if (Array.isArray(model)) return; // a concrete key can't index an array
  const obj = model as Record<string, unknown>;
  if (!(head! in obj)) return;
  if (rest.length === 0) obj[head!] = sortScalarSet(obj[head!]);
  else sortScalarSetAtNestedPath(obj[head!], rest);
}

function sortUnorderedSetProps(
  model: Record<string, unknown>,
  resourceType: string,
  schemaObjectArrayKeys: readonly string[] = [],
  schemaScalarPaths: readonly string[] = []
): void {
  const objKeys = new Set([
    ...(UNORDERED_OBJECT_ARRAY_PROPS[resourceType] ?? []),
    ...schemaObjectArrayKeys,
  ]);
  // A key whose ORDER is semantically significant (a Logs Transformer processor pipeline)
  // must NOT be sorted even when the schema marks it insertionOrder:false — sorting the live
  // side alone would re-skew the finding index vs the raw model the revert patches (#529).
  const orderSig = ORDER_SIGNIFICANT_ARRAY_KEYS[resourceType];
  for (const k of objKeys)
    if (!orderSig?.has(k) && Array.isArray(model[k])) model[k] = sortUnorderedObjectArray(model[k]);
  // Scalar unordered-set paths from BOTH sources (per-type table + schema insertionOrder:false).
  // A TOP-LEVEL path is a plain key; a NESTED/dotted path (`DistributionConfig.Restrictions.
  // GeoRestriction.Locations`, CodeDeploy `AutoRollbackConfiguration.Events`, CodePipeline
  // `Triggers.*.…Includes`) is walked into. Before #808 only top-level keys were sorted here,
  // so a recorded baseline stored a nested set RAW while the DECLARED loop tolerated its
  // reorder at compare time — an asymmetry that false-flagged a nested set AWS re-ordered as
  // "changed since record". Sorting nested paths here too makes the live normalizer's output
  // symmetric with the declared-compare tolerance.
  // A SCALAR path whose ORDER is semantically significant (AppSync Resolver
  // `PipelineConfig.Functions` — pipeline functions execute in array order) must NOT be
  // sorted even when the schema marks it insertionOrder:false: sorting the live side would
  // fold an out-of-band execution-order change to equality, hiding real drift (#880).
  const orderSigPaths = ORDER_SIGNIFICANT_PATHS[resourceType];
  for (const path of [...(UNORDERED_ARRAY_PROPS[resourceType] ?? []), ...schemaScalarPaths]) {
    if (orderSigPaths?.has(path)) continue;
    if (path.includes('.')) sortScalarSetAtNestedPath(model, path.split('.'));
    // Guard on presence — assigning `model[path]` for an absent top-level key would
    // MATERIALIZE it as `undefined`, injecting a phantom key into the live model that
    // reads as a false undeclared finding.
    else if (path in model) model[path] = sortScalarSet(model[path]);
  }
}

export function normalizeLiveModel(
  liveRaw: Record<string, unknown>,
  schema: SchemaInfo,
  opts: { oaiCanonicalIds?: Record<string, string>; resourceType?: string } = {}
): Record<string, unknown> {
  const oaiMap = opts.oaiCanonicalIds ?? {};
  const live = canonicalizeForCompare(
    rewriteOaiPrincipalsDeep(stripAwsTagsDeep(stripCcApiAwsManagedFields(liveRaw)), oaiMap),
    opts.resourceType
  ) as Record<string, unknown>;
  deepStripPaths(live, schema.readOnlyPaths);
  deepStripPaths(live, schema.writeOnlyPaths);
  if (opts.resourceType)
    sortUnorderedSetProps(
      live,
      opts.resourceType,
      // OBJECT arrays: top-level keys only — nested (dotted) object-array paths are handled
      // per-key in the declared compare loop (identity alignment + per-element sort), which
      // the shared normalizer cannot replicate; the undeclared loop emits nested inventory
      // per-path. SCALAR sets, however, ARE nested-walked below so the baseline/live compare
      // is symmetric with the declared-loop reorder tolerance (#808).
      (schema.unorderedObjectArrayPaths ?? []).filter((p) => !p.includes('.')),
      schema.unorderedScalarPaths ?? []
    );
  return live;
}

// A per-element drift inside an UNORDERED_OBJECT_ARRAY is computed on arrays SORTED by
// canonical JSON on both sides, so the drift path's leading array index is the SORTED
// position — which need not match the user's TEMPLATE order (declared [require_ssl,
// enable_user_activity_logging, …] sorts to [enable_user_activity_logging, …], so a
// change to the 2nd declared entry reports as index 0). Re-map that index back to the
// element's position in the raw (template-order) declared array so the reported path
// matches what the user actually wrote. Display-only: revert reads Finding.wholeArrayRevert
// (a whole-array replace), never this index. Falls back to the sorted path if the element
// can't be located (e.g. a type whose nested sub-arrays were also re-sorted, so the sorted
// element no longer deep-equals its raw form).
function remapSortedIndexToDeclared(
  path: string,
  arrayKey: string,
  sortedDeclared: unknown[],
  rawDeclared: unknown[]
): string {
  const prefix = `${arrayKey}.`;
  if (!path.startsWith(prefix)) return path;
  const m = /^(\d+)(\..*|)$/.exec(path.slice(prefix.length));
  if (!m) return path;
  const el = sortedDeclared[Number(m[1])];
  if (el === undefined) return path;
  const rawIdx = rawDeclared.findIndex((e) => deepEqual(e, el));
  return rawIdx < 0 ? path : `${arrayKey}.${rawIdx}${m[2]}`;
}

// Translate a Custom::S3BucketNotifications CR's DECLARED `NotificationConfiguration` (rendered
// by CDK in the S3 `put-bucket-notification-configuration` API shape) into the CFn RESOURCE shape
// the live `AWS::S3::Bucket` read returns, so the two can be equality-gated (#1283). The API →
// resource shape differences CDK's notifications-resource.js produces:
//   - `LambdaFunctionConfigurations[]`  -> `LambdaConfigurations[]`
//       `.LambdaFunctionArn`            -> `.Function`
//   - `QueueConfigurations[].QueueArn`  -> `.Queue`
//   - `TopicConfigurations[].TopicArn`  -> `.Topic`
//   - each config's `Events: [ev]` (array) -> `Event: ev` (the live read is per-event scalar)
//   - `Filter.Key.FilterRules[]`        -> `Filter.S3Key.Rules[]`
//       rule `Name` is lower-case (`prefix`/`suffix`) declared, capitalized (`Prefix`/`Suffix`)
//       live -> canonicalize both to lower-case so casing is not false drift.
//   - `EventBridgeConfiguration: {}`    -> `EventBridgeConfiguration: {}` (passes through).
// A per-config `Events` array with >1 entry maps to one live config per event (AWS materializes
// each separately). Unknown extra keys pass through unchanged so a value we could not translate
// still surfaces (fail-safe: never silently drop what we did not verify). Order is irrelevant —
// the caller canonicalizes BOTH sides (canonicalizeForCompare sorts unordered object arrays).
const S3_NOTIF_FILTER_RULE_NAMES: Record<string, string> = {
  prefix: 'prefix',
  suffix: 'suffix',
  Prefix: 'prefix',
  Suffix: 'suffix',
};
function canonS3NotifFilter(filter: unknown): unknown {
  if (!filter || typeof filter !== 'object') return filter;
  const f = filter as Record<string, unknown>;
  // Accept either the declared `Key.FilterRules` or the live `S3Key.Rules` container.
  const inner = (f.S3Key ?? f.Key) as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== 'object') return filter;
  const rulesRaw = (inner.Rules ?? inner.FilterRules) as unknown;
  const rules = Array.isArray(rulesRaw)
    ? sortUnorderedObjectArray(
        rulesRaw.map((r) => {
          if (!r || typeof r !== 'object') return r;
          const rule = r as Record<string, unknown>;
          const name = rule.Name;
          return {
            ...rule,
            Name: typeof name === 'string' ? (S3_NOTIF_FILTER_RULE_NAMES[name] ?? name) : name,
          };
        })
      )
    : rulesRaw;
  return { S3Key: { Rules: rules } };
}
function translateBucketNotificationConfigs(
  configs: unknown,
  arnKey: string,
  targetKey: string
): unknown[] {
  if (!Array.isArray(configs)) return [];
  const out: unknown[] = [];
  for (const c of configs) {
    if (!c || typeof c !== 'object') {
      out.push(c);
      continue;
    }
    const cfg = c as Record<string, unknown>;
    const { Events, Filter, [arnKey]: arn, ...rest } = cfg;
    const base: Record<string, unknown> = { ...rest };
    if (arn !== undefined) base[targetKey] = arn;
    if (Filter !== undefined) base.Filter = canonS3NotifFilter(Filter);
    // `Events` (declared array) -> one live config per event under scalar `Event`; a config
    // that already used a scalar `Event` (or omitted events) is emitted once as-is.
    const events = Array.isArray(Events) ? Events : Events !== undefined ? [Events] : undefined;
    if (events && events.length > 0) {
      for (const ev of events) out.push({ ...base, Event: ev });
    } else {
      out.push(base);
    }
  }
  return out;
}
// Canonicalize a `NotificationConfiguration` (live OR translated-declared) so casing-only
// filter-rule differences (`Prefix`/`Suffix` live vs `prefix`/`suffix` declared) are not false
// drift: lower-case every config's `Filter` rule name via canonS3NotifFilter. Applied to BOTH
// compare sides symmetrically, so it can never make two genuinely different values compare equal.
function canonS3NotifBucketConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const c = config as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  for (const key of ['LambdaConfigurations', 'QueueConfigurations', 'TopicConfigurations']) {
    const arr = c[key];
    if (!Array.isArray(arr)) continue;
    out[key] = sortUnorderedObjectArray(
      arr.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const e = entry as Record<string, unknown>;
        return 'Filter' in e ? { ...e, Filter: canonS3NotifFilter(e.Filter) } : e;
      })
    );
  }
  return out;
}
function translateDeclaredBucketNotification(
  declaredConfig: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('EventBridgeConfiguration' in declaredConfig)
    out.EventBridgeConfiguration = declaredConfig.EventBridgeConfiguration;
  const lambda = translateBucketNotificationConfigs(
    declaredConfig.LambdaFunctionConfigurations ?? declaredConfig.LambdaConfigurations,
    'LambdaFunctionArn',
    'Function'
  );
  if (lambda.length > 0) out.LambdaConfigurations = lambda;
  const queue = translateBucketNotificationConfigs(
    declaredConfig.QueueConfigurations,
    'QueueArn',
    'Queue'
  );
  if (queue.length > 0) out.QueueConfigurations = queue;
  const topic = translateBucketNotificationConfigs(
    declaredConfig.TopicConfigurations,
    'TopicArn',
    'Topic'
  );
  if (topic.length > 0) out.TopicConfigurations = topic;
  // Preserve any container key we did not explicitly translate (fail-safe: a future/unknown
  // config family stays present so a live value we could not map still surfaces rather than
  // being folded away).
  for (const [k, v] of Object.entries(declaredConfig)) {
    if (
      k === 'EventBridgeConfiguration' ||
      k === 'LambdaFunctionConfigurations' ||
      k === 'LambdaConfigurations' ||
      k === 'QueueConfigurations' ||
      k === 'TopicConfigurations'
    )
      continue;
    out[k] = v;
  }
  return out;
}

// #676: an API Gateway resource policy authored with the documented abbreviated resource form
// `execute-api:/...` (the shape CDK's grantInvokeFromVpcEndpointsOnly + the AWS console/docs use,
// since the api id does not exist at authoring time) is echo-EXPANDED by the service to the full
// ARN `arn:<partition>:execute-api:<region>:<account>:<apiId>/...` on read. The two are
// semantically identical, so expand the DECLARED shorthand to the same ARN before the compare —
// `execute-api:` is a literal prefix AWS replaces textually, so a suffix like `/*` or
// `/prod/GET/*` is preserved. Equality-gated (context-derived, fold tier 2): a resource pointing
// at a DIFFERENT api id / region / path expands to a non-matching ARN and still surfaces. Applied
// to Resource + NotResource on every statement; other (already-ARN or non-execute-api) resources
// are untouched.
function expandExecuteApiResources(policy: unknown, arnPrefix: string): unknown {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return policy;
  const p = policy as Record<string, unknown>;
  const stmts = p['Statement'];
  if (!Array.isArray(stmts)) return policy;
  const PREFIX = 'execute-api:';
  const expand = (r: unknown): unknown =>
    typeof r === 'string' && r.startsWith(PREFIX) ? arnPrefix + r.slice(PREFIX.length) : r;
  const newStmts = stmts.map((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
    const stmt = { ...(s as Record<string, unknown>) };
    for (const key of ['Resource', 'NotResource']) {
      const v = stmt[key];
      if (typeof v === 'string') stmt[key] = expand(v);
      else if (Array.isArray(v)) stmt[key] = v.map(expand);
    }
    return stmt;
  });
  return { ...p, Statement: newStmts };
}

// Compiled-JSONata cache: the same `propertyTransform` sub-expression string recurs across every
// resource of a type (and across the whole `--all` run), so compile once and reuse. Keyed on the
// raw expression string. A value of `null` memoizes a compile FAILURE so a malformed expression is
// not re-parsed (and never throws) on the hot path. (#881)
const transformCache = new Map<string, jsonata.Expression | null>();
function compileTransform(expr: string): jsonata.Expression | null {
  if (transformCache.has(expr)) return transformCache.get(expr) ?? null;
  let compiled: jsonata.Expression | null = null;
  try {
    compiled = jsonata(expr);
  } catch {
    compiled = null; // unsupported / malformed — fail-open, memoize the failure
  }
  transformCache.set(expr, compiled);
  return compiled;
}

// #881: honor a registry-schema `propertyTransform`. `transformExpr` is the JSONata string for a
// declared property path (possibly ` $OR `-joined alternatives, AWS's convention). Evaluate each
// alternative against BOTH the resource ROOT and the property's PARENT object (resource authors
// reference the property from either scope — e.g. AmazonMQ `MaintenanceWindowStartTime.DayOfWeek`
// from root vs Cassandra `ColumnType` / CodeDeploy `Description` from the parent element/object),
// and report whether ANY produces a value DEEP-EQUAL to the live value. This is the exact model
// CloudFormation's own drift detection uses: apply transform(declared) and compare to the read
// value; if they match, the property is IN_SYNC. STRICTLY equality-gated + FAIL-OPEN — on any
// parse/eval error, or when no alternative matches live, it returns false (the finding surfaces
// unchanged), so it can ONLY fold a declared FP where the service transform reproduces live
// EXACTLY, and can NEVER hide real drift.
function matchesPropertyTransform(
  transformExpr: string,
  declaredValue: unknown,
  parentObject: unknown,
  rootObject: unknown,
  liveValue: unknown,
  leafName: string
): boolean {
  // Candidate JSONata input scopes, tried in turn (equality-gated, so trying several is safe):
  //  - parentObject / rootObject: the two scopes real schemas reference the property from.
  //  - a SYNTHETIC `{ [leafName]: declaredValue }`: guarantees the leaf field is bound by name even
  //    when array reindexing (unordered-array sort) makes the raw-tree index unreliable — e.g.
  //    Cassandra `$lowercase(ColumnType)` needs `{ ColumnType: <value> }` regardless of position.
  //  - declaredValue itself: for a `$`-self-referencing expression.
  const scopes = buildTransformScopes(declaredValue, parentObject, rootObject, leafName);
  for (const alt of transformExpr.split(' $OR ')) {
    const expr = alt.trim();
    if (!expr) continue;
    const compiled = compileTransform(expr);
    if (!compiled) continue;
    for (const scope of scopes) {
      try {
        const out = compiled.evaluate(scope as unknown);
        if (out !== undefined && deepEqual(out, liveValue)) return true;
        // #1294: ~35 registry propertyTransforms produce a PATTERN string, not a value (constant regexes
        // like DirectConnect Location `^[a-zA-Z0-9-]+$`, or an ARN pattern built from the declared value
        // for ECS Service TaskDefinition). CloudFormation's own drift engine matches the live value against
        // the transformed string as an ANCHORED pattern; replicate that. Guarded: only when the transform
        // OUTPUT and the live value are both strings AND the output differs from the raw declared value (a
        // value-producing transform whose concrete output already failed deepEqual is not re-interpreted as
        // a pattern). Anchored full-match keeps it equality-gated in spirit — a genuinely different live
        // value still surfaces. Inside the existing fail-open try, so a malformed pattern just falls through.
        if (
          typeof out === 'string' &&
          typeof liveValue === 'string' &&
          typeof declaredValue === 'string' &&
          out !== declaredValue &&
          new RegExp('^(?:' + out + ')$').test(liveValue)
        )
          return true;
      } catch {
        // eval error on this scope — try the next scope / alternative (fail-open)
      }
    }
  }
  return false;
}

// #1304: build the ordered list of JSONata input scopes for a `propertyTransform`, INCLUDING a
// type-coerced retry for the numeric-string / number mismatch. `resolveRef` resolves a `Ref` to a
// CloudFormation Parameter from DescribeStacks parameter values, which are ALWAYS strings — even for
// a `Type: Number` parameter — so a template that parameterizes e.g. `StartingPositionTimestamp`
// carries the declared leaf as the STRING `"1700000000"`. A numeric transform (`... * 1000`) then
// throws JSONata `T2001` ("left side of * must be a number") → fails open → the s→ms declared FP
// #881 fixed is back for the parameterized form. The reverse also bites: GameLift Fleet
// `AnywhereConfiguration.Cost` uses `$contains(Cost, ".") ? ...` which throws on a number-declared
// Cost. So when the declared LEAF is a numeric string, append scopes with a `Number()`-coerced leaf;
// when it is a number, append scopes with a `String()`-coerced leaf. The coerced scopes are tried
// AFTER the raw ones, so an expression that already matches uncoerced is unaffected, and the fold
// stays STRICTLY equality-gated (transform(coerced-declared) must still deep-equal live) — detection
// is preserved. Purely additive: no coercion when the leaf is neither a numeric string nor a number.
function buildTransformScopes(
  declaredValue: unknown,
  parentObject: unknown,
  rootObject: unknown,
  leafName: string
): unknown[] {
  const scopes: unknown[] = [
    parentObject,
    rootObject,
    { [leafName]: declaredValue },
    declaredValue,
  ];
  const coerced = coerceNumericLeaf(declaredValue);
  if (coerced === undefined) return scopes;
  // Rebuild the by-name synthetic + parent/root scopes with the coerced leaf substituted, so an
  // expression referencing the leaf by name OR through its parent/root object sees a number where
  // the transform expects one (and vice versa).
  const coercedParent = substituteLeaf(parentObject, leafName, coerced);
  const coercedRoot = substituteLeaf(rootObject, leafName, coerced);
  if (coercedParent !== undefined) scopes.push(coercedParent);
  if (coercedRoot !== undefined && coercedRoot !== coercedParent) scopes.push(coercedRoot);
  scopes.push({ [leafName]: coerced }, coerced);
  return scopes;
}

// Return the type-coerced counterpart of a leaf when it is a numeric string (→ Number) or a number
// (→ String), else `undefined` (nothing to retry). A numeric string is one that round-trips through
// Number without becoming NaN and is non-empty — `"1700000000"` → 1700000000; `"abc"`/`""` → skip.
function coerceNumericLeaf(value: unknown): number | string | undefined {
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
}

// Return a shallow copy of `obj` with `obj[leafName]` replaced by `coerced`, when `obj` is a plain
// object that actually carries that leaf; else `undefined` (no coerced variant of this scope). Only
// the direct leaf is substituted — the transform reads it by that exact name from the parent/root.
function substituteLeaf(obj: unknown, leafName: string, coerced: number | string): unknown {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const rec = obj as Record<string, unknown>;
  if (!(leafName in rec)) return undefined;
  return { ...rec, [leafName]: coerced };
}

// Read the sub-value at a dotted path within a value tree (numeric segments index arrays).
// Returns `undefined` if any segment is missing. Twin of `resolveParentObject`, but returns the
// value AT the path rather than its parent. (#1298)
function valueAtDottedPath(root: unknown, dottedPath: string): unknown {
  let node: unknown = root;
  for (const seg of dottedPath.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

// #1298: honor a registry-schema `propertyTransform` that is keyed at an ANCESTOR of the drift
// path. A schema can key its transform at a parent object (e.g. AWS::Config::ConfigRule keys the
// transform at `Source`, an expression of the shape `$ ~> |$.Source|...|` that returns the whole
// transformed ROOT). When the service materializes an extra element into a CHILD of that ancestor
// (a CUSTOM_LAMBDA rule's `Source.SourceDetails` gains an `OversizedConfigurationItemChangeNotification`
// entry), `calculateResourceDrift` reports the divergence at the CHILD path `Source.SourceDetails` —
// where no transform is keyed — so the exact/`*`-form lookup at the drift path misses and the finding
// is a permanent declared False Positive (and `revert` would strip the service-required detail →
// non-convergence loop). CloudFormation's own drift detection folds this: apply transform(declared)
// and compare to the read value at the ancestor.
//
// So when NO transform matched at the drift path, walk UP its ancestor dotted paths (nearest parent
// first, up to the root). For each ancestor `A` that carries a transform (exact or `*`-normalized
// key), evaluate the transform on the declared ROOT scope, extract the sub-value at `A` from BOTH
// the transform OUTPUT and the LIVE model, and fold only when they DEEP-EQUAL. STRICTLY equality-
// gated + FAIL-OPEN: on any parse/eval/extract error, or when the ancestor sub-values differ, it
// returns false and the finding surfaces unchanged — so it can ONLY fold a declared FP the service
// transform reproduces at the ancestor EXACTLY, and can NEVER hide real drift.
function matchesAncestorPropertyTransform(
  propertyTransforms: Record<string, string>,
  driftPath: string,
  declaredRoot: unknown,
  liveRoot: unknown
): boolean {
  const segs = driftPath.split('.');
  // Nearest parent up to (and including) the root's top-level key; skip the drift path itself
  // (already tried by the exact/`*` lookup at the call site).
  for (let end = segs.length - 1; end >= 1; end--) {
    const ancestor = segs.slice(0, end).join('.');
    const transformExpr =
      propertyTransforms[ancestor] ?? propertyTransforms[ancestor.replace(/\.\d+(?=\.|$)/g, '.*')];
    if (transformExpr === undefined) continue;
    const liveAtAncestor = valueAtDottedPath(liveRoot, ancestor);
    if (liveAtAncestor === undefined) continue;
    for (const alt of transformExpr.split(' $OR ')) {
      const expr = alt.trim();
      if (!expr) continue;
      const compiled = compileTransform(expr);
      if (!compiled) continue;
      try {
        // The ancestor transform (`$ ~> |$.Source|...|`) transforms and returns the whole ROOT,
        // so evaluate it on the declared root and read the sub-value back out at the ancestor.
        const out = compiled.evaluate(declaredRoot as unknown);
        if (out === undefined) continue;
        const transformedAtAncestor = valueAtDottedPath(out, ancestor);
        if (transformedAtAncestor !== undefined && deepEqual(transformedAtAncestor, liveAtAncestor))
          return true;
      } catch {
        // eval error on this alternative — try the next (fail-open)
      }
    }
  }
  return false;
}

// Resolve the PARENT object of a dotted drift path within a value tree. `PartitionKeyColumns.0.
// ColumnType` → the element object at index 0; `MaintenanceWindowStartTime.DayOfWeek` → the
// MaintenanceWindowStartTime object; `StartingPositionTimestamp` (top-level) → the root itself.
// Best-effort: returns undefined if any segment is missing (the transform then just cannot match
// against it — fail-open). Numeric segments index arrays. (#881)
function resolveParentObject(root: unknown, dottedPath: string): unknown {
  const segs = dottedPath.split('.');
  if (segs.length <= 1) return root;
  let node: unknown = root;
  for (const seg of segs.slice(0, -1)) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

export const GETTEMPLATE_MASK_NOTE =
  'declared value unverifiable — CloudFormation GetTemplate masks non-ASCII characters as "?"';

// The SINGLE funnel every `declared`-drift emission must flow through. CloudFormation's
// GetTemplate masks every non-ASCII character in a stored string literal as `?` (see
// isCfnTemplateNonAsciiMask), so any compare of a GetTemplate-sourced desired against an
// intact live value can false-flag; the plain string-diff path demotes such a mask-only
// difference to a readGap, but a special-case branch that pushed its `declared` finding
// DIRECTLY bypassed that demotion — exactly how #712's SFN DefinitionString branch
// regressed into a guaranteed false drift (#1247), and JSON_STRING_PROPS repeated it
// (#1337). Funnelling the push applies the demotion structurally, so a future branch
// cannot reintroduce the bypass; a companion meta-test asserts no direct
// `tier: 'declared'` push exists outside this function. Branches that compare PARSED
// forms (SFN / JSON_STRING_PROPS) still run their own mask-tolerant structural checks
// first — this funnel is the raw-value backstop, not a replacement.
function pushDeclaredFinding(findings: Finding[], finding: Omit<Finding, 'tier'>): void {
  // Demote ONLY when the mask is what makes the two sides differ (mask-tolerant equal,
  // strictly unequal) — a site that pushes two genuinely equal values keeps its
  // (buggy) declared finding visible instead of being silently relabelled a readGap.
  if (
    !deepEqual(finding.desired, finding.actual) &&
    deepEqualModuloNonAsciiMask(finding.desired, finding.actual)
  ) {
    findings.push({
      tier: 'readGap',
      logicalId: finding.logicalId,
      resourceType: finding.resourceType,
      path: finding.path,
      ...(finding.attributeKey !== undefined ? { attributeKey: finding.attributeKey } : {}),
      note: GETTEMPLATE_MASK_NOTE,
    });
    return;
  }
  findings.push({ tier: 'declared', ...finding });
}

export function classifyResource(
  resource: DesiredResource,
  liveRaw: Record<string, unknown>,
  schema: SchemaInfo,
  opts: {
    accountId?: string;
    region?: string;
    kmsAliasTargets?: Record<string, string>; // alias/aws/* -> target key id, for strict KMS match
    // CFn STACK-level tags (`cdk deploy --tags`) — subtracted from each resource's live `Tags`
    // (except keys the resource declares) to avoid a first-run / declared-tier tag FP (#683).
    stackTags?: Record<string, string>;
    // #889: the account/region VPC-default security-group ids (one per VPC), prefetched by
    // gather.ts so the UNDECLARED default-SG-list fold (ALB SecurityGroups / ENI GroupSet) is a
    // DERIVED equality gate rather than a value-independent one: a single default SG folds, a
    // 2+-element APPEND or a single non-default SG SWAP surfaces. Undefined/empty → fail open (fold).
    defaultSgIds?: ReadonlySet<string>;
    // #1269: the account/region DEFAULT-VPC subnet ids, prefetched by gather.ts so the UNDECLARED
    // default-subnet-list fold (RedshiftServerless Workgroup SubnetIds) is a DERIVED gate: a
    // workgroup that declares no SubnetIds is placed into the default VPC and reads back all its
    // subnets, so fold when EVERY live subnet is a default-VPC subnet and surface an OOB
    // re-placement into a subnet outside it. Undefined/empty → fail open (fold).
    defaultSubnetIds?: ReadonlySet<string>;
    oaiCanonicalIds?: Record<string, string>; // OAI id -> S3CanonicalUserId, for CloudFront OAI principal match
    // Rules declared by SIBLING standalone AWS::EC2::SecurityGroupIngress/::SecurityGroupEgress
    // resources, keyed by the target SG's resolved GroupId (== the SG's physical id). Subtracted
    // from an AWS::EC2::SecurityGroup's reflected live rule arrays so they are not double-counted.
    siblingSgRules?: Record<string, { ingress: unknown[]; egress: unknown[] }>;
    // Statements declared by SIBLING AWS::Events::EventBusPolicy resources, keyed by the target
    // bus identifier (== the bus's physical id / Name; "default" for the default bus). Subtracted
    // from an AWS::Events::EventBus's reflected `Policy.Statement[]` so sibling-owned statements
    // are not double-counted; any out-of-band statement (matching no sibling) still surfaces.
    siblingEventBusPolicies?: Record<string, unknown[]>;
    // Managed-policy ARNs (/names) attached by SIBLING AWS::IAM::ManagedPolicy resources whose
    // `Roles`/`Users`/`Groups` reference this principal, keyed by the principal identifier (==
    // physical id == RoleName/UserName/GroupName). Subtracted from an IAM Role/User/Group's
    // reflected live `ManagedPolicyArns` (a ListAttached*Policies union) so a sibling-attached
    // policy is not a declared-tier FP that survives record + a detach-hazard on revert (#698); an
    // out-of-band attachment matching no sibling still surfaces.
    siblingManagedPolicyAttachments?: Record<string, string[]>;
    // Group names added by SIBLING AWS::IAM::UserToGroupAddition resources whose `Users` reference
    // this user, keyed by the user identifier (== physical id == UserName). Subtracted from an IAM
    // User's reflected live `Groups` so the sibling-added membership is not a first-run undeclared
    // FP (the addition resource is itself a CC-gap skipped type, checked nowhere); an out-of-band
    // group matching no sibling still surfaces.
    siblingUserGroups?: Record<string, string[]>;
    // LifecycleHook NAMES declared by SIBLING standalone AWS::AutoScaling::LifecycleHook resources
    // targeting this ASG, keyed by the ASG identifier (== physical id == AutoScalingGroupName).
    // Subtracted BY NAME from an AWS::AutoScaling::AutoScalingGroup's reflected live
    // `LifecycleHookSpecificationList` (which merges inline + standalone hooks, origin-
    // indistinguishable) so a mixed inline+standalone stack is not a declared-tier FP that survives
    // record + a revert that would DELETE the sibling hook, and a standalone-only ASG is not an
    // undeclared FP; an out-of-band hook matching no sibling still surfaces (#700).
    siblingLifecycleHooks?: Record<string, string[]>;
    // Identities (logicalId + physicalId == PublicIp) of every AWS::EC2::EIP that a DECLARED
    // sibling associates — an AWS::EC2::EIPAssociation targeting it, or an AWS::EC2::NatGateway
    // consuming it (see buildSiblingEipAssociations). An EIP's live `NetworkInterfaceId` reflects
    // the ENI its address is bound to; a sibling-explained association is folded to atDefault (the
    // binding is IaC intent), but an association with NO declaring sibling is an out-of-band
    // `associate-address` HIJACK of the static IP and SURFACES (#892). The ENI value is AWS-assigned
    // at association time, so the fold is presence-gated (a declaring sibling explains any binding).
    siblingEipAssociations?: Set<string>;
    // Identities (logicalId + physicalId == the TG ARN) of every AWS::ElasticLoadBalancingV2::
    // TargetGroup a DECLARED sibling dynamically registers into — an AWS::ECS::Service
    // (LoadBalancers[].TargetGroupArn), an AWS::AutoScaling::AutoScalingGroup (TargetGroupARNs), or
    // the group's own TargetType: lambda (see buildSiblingTargetGroupRegistrars). A TG's live
    // `Targets` reflects the registered membership; a sibling-registered group's membership is
    // IaC-driven runtime churn (task IPs / instances recycle) and folds `generated`, but a NON-EMPTY
    // membership on a TG NO registrar explains is an out-of-band `elbv2 register-targets` — traffic
    // interception — and SURFACES (#891). Presence-gated (a registrar explains any membership).
    siblingTargetGroupRegistrars?: Set<string>;
    // Bucket physical ids whose S3 notifications are managed by a Custom::S3BucketNotifications
    // custom resource (see buildBucketNotificationManaged): the live bucket reflects the
    // CR-applied NotificationConfiguration the bucket resource never declares.
    bucketNotificationManaged?: Set<string>;
    // #1283: per managed-bucket physical id, the CR's DECLARED `NotificationConfiguration` in the
    // S3 API shape (see buildBucketNotificationConfigs). classify translates it into the live CFn
    // resource shape and EQUALITY-GATES against the live value — folding a clean-deploy match but
    // SURFACING an out-of-band change the CR did not apply (tier-2 derived, preserves detection).
    bucketNotificationConfigs?: Record<string, Record<string, unknown>>;
    // Per child physical id, the parent cluster's live model — for the CLUSTER_ECHO_CHILD
    // strip (an Aurora DBInstance echoing its DBCluster's cluster-level config).
    clusterEchoModel?: Record<string, Record<string, unknown>>;
    // #978: per AWS::RDS::OptionGroup physical id, the option-default catalog resolved live from
    // `describe-option-group-options` — `{ optionName: { settingName: DefaultValue | null } }`.
    // Folds RDS-materialized value-bearing default-fill settings to atDefault (see
    // rdsMaterializedDefault). Absent when the read was denied / on offline replay without it.
    rdsOptionSettingDefaults?: Record<string, Record<string, Record<string, string | null>>>;
    // Top-level exempted props whose SDK_SUPPLEMENTS read FAILED (#849, from router.ts): they
    // are absent from the live model NOT because the resource lacks them, but because the read
    // could not verify them. Each is surfaced as a `readGap` (not a false declared removal, not
    // a silent hole) regardless of declared-ness or value shape.
    supplementReadGapPaths?: string[] | undefined;
    // #975: first `PortRanges` FromPort of each AWS::GlobalAccelerator::Listener, keyed by the
    // listener's physical id (== its ARN, which an EndpointGroup references via ListenerArn). An
    // EndpointGroup that omits HealthCheckPort reads back this port (AWS resolves the schema's -1
    // sentinel default to the listener's port), so classify derives + equality-gates the undeclared
    // HealthCheckPort from it. Built from the desired set in gather.ts (buildSiblingListenerPorts).
    siblingListenerPorts?: Record<string, number>;
  } = {}
): Finding[] {
  const { logicalId, resourceType, physicalId, declared: declaredIn } = resource;
  const findings: Finding[] = [];

  // Normalize the LIVE model via the shared `normalizeLiveModel` — strip AWS-managed
  // fields + aws:* tags (live-only), reconcile CloudFront OAI principals (no-op without
  // a resolved map), run the shared canonicalization pipeline (policy docs + tag lists +
  // id arrays so reordering / scalar-vs-array / OAI principal-form is not false drift),
  // then drop schema readOnly (pure noise) + writeOnly (unreadable) paths at any depth.
  // The `added` tier uses the SAME helper, so the two live-normalization paths can never
  // silently diverge; the pipeline is shared with baseline-file.ts so baseline values
  // normalize identically (see pipeline.ts).
  const oaiMap = opts.oaiCanonicalIds ?? {};
  // AWS sometimes GENERATES an identity field the template omitted (S3
  // LifecycleConfiguration.Rules[].Id when `addLifecycleRule` is called without an `id`).
  // The live element then carries the field while the declared element does not, so the
  // per-side identity sort would key the LIVE array by the generated id and leave the
  // DECLARED array in template order — misaligning every element into false drift. Strip
  // such asymmetric identity fields from a clone of each side BEFORE canonicalization so
  // neither side is keyed by them (AWS preserves the array order). `declaredIn` can hold
  // the UNRESOLVED Symbol, which structuredClone rejects — clone it symbol-safe.
  const liveForCompare = structuredClone(liveRaw);
  const declaredForCompare = cloneDeepWithSymbols(declaredIn) as Record<string, unknown>;
  stripAsymmetricIdentityFields(declaredForCompare, liveForCompare);
  // #683 — subtract CFn stack-level tags (`cdk deploy --tags`) propagated onto this resource's
  // live `Tags`, keeping any key the resource itself declares (compared normally).
  const live = subtractPropagatedStackTags(
    normalizeLiveModel(liveForCompare, schema, { oaiCanonicalIds: oaiMap, resourceType }),
    opts.stackTags ?? {},
    declaredTagKeys(declaredForCompare)
  );
  const declared = canonicalizeForCompare(
    rewriteOaiPrincipalsDeep(declaredForCompare, oaiMap),
    resourceType
  ) as Record<string, unknown>;
  // Drop a parent's reflected child-aggregate property (e.g. SNS Topic.Subscription)
  // UNLESS the template declares it inline — cdkrd tracks those children as their own
  // resources (+ the `added` enumerator), so comparing the reflection would double-report
  // (see REFLECTED_CHILD_PROPS). Fail-open: a declared inline value is still compared.
  const reflected = REFLECTED_CHILD_PROPS[resourceType];
  if (reflected && !(reflected in declared)) delete live[reflected];
  // Subtract from an event bus's reflected resource-policy the statements owned by its
  // sibling AWS::Events::EventBusPolicy resources (keyed by the bus identifier in
  // opts.siblingEventBusPolicies) UNLESS the template pins `Policy` inline — the siblings
  // are tracked + compared as their own resources, so leaving their statements on the bus
  // double-reports them + surfaces a first-run FP (#699). This is STATEMENT-LEVEL, so a
  // purely out-of-band statement (matching no sibling) is left to surface. Fail-open: an
  // inline-declared `Policy` is compared normally.
  if (resourceType === EVENT_BUS_TYPE && !(EVENT_BUS_POLICY_PROP in declared)) {
    const busKey = physicalId ?? resource.declared.Name;
    const sibStatements =
      typeof busKey === 'string' ? opts.siblingEventBusPolicies?.[busKey] : undefined;
    if (sibStatements) subtractSiblingEventBusStatements(live, sibStatements);
  }
  // An ECS Cluster reflects the CapacityProviders / DefaultCapacityProviderStrategy declared by
  // its sibling AWS::ECS::ClusterCapacityProviderAssociations resource — the only CFn way to set
  // them (the Cluster's own schema carries neither). The association is tracked + compared as its
  // own resource, so leaving them on the cluster's live model reads as false undeclared drift. Drop
  // them ONLY when a sibling association references this cluster (hasSiblingCapacityProviders); a
  // cluster with capacity providers set purely out of band (no association resource) keeps them.
  if (resourceType === 'AWS::ECS::Cluster' && resource.hasSiblingCapacityProviders) {
    for (const p of ['CapacityProviders', 'DefaultCapacityProviderStrategy']) {
      if (!(p in declared)) delete live[p];
    }
  }
  // Drop declared scalar props AWS re-normalizes on read (SSM Document DocumentFormat:
  // any authored YAML/TEXT is stored + returned as JSON) from BOTH sides so the write-time
  // authoring hint is not a spurious declared drift (see READ_NORMALIZED_DECLARED_PATHS).
  for (const p of READ_NORMALIZED_DECLARED_PATHS[resourceType] ?? []) {
    delete declared[p];
    delete live[p];
  }
  // Subtract rules declared by sibling standalone SecurityGroupIngress/Egress resources from
  // an AWS::EC2::SecurityGroup's reflected live rule arrays (see SG_RULE_REFLECTION). Keyed by
  // the SG's resolved GroupId (== its physical id). The sibling rules are themselves compared
  // as their own resources, so this leaves only the inline-declared rules (plus any out-of-band
  // rule, which matches no sibling) to compare.
  if (resourceType === 'AWS::EC2::SecurityGroup') {
    const sib = physicalId ? opts.siblingSgRules?.[physicalId] : undefined;
    if (sib) {
      for (const [prop, side] of Object.entries(SG_RULE_REFLECTION)) {
        subtractSiblingSgRules(live, prop, sib[side]);
      }
    }
  }
  // Subtract from an IAM Role/User/Group's reflected live `ManagedPolicyArns` (a
  // ListAttached*Policies union) the ARNs attached by SIBLING AWS::IAM::ManagedPolicy resources
  // (keyed by the principal's physical id in opts.siblingManagedPolicyAttachments). The siblings
  // are tracked + compared as their own resources, so leaving their ARNs on the principal is a
  // declared-tier FP that survives record + a whole-array-revert detach hazard (#698). Runs
  // regardless of whether the principal declares `ManagedPolicyArns` — only sibling-OWNED ARNs are
  // removed, so the principal's own declared ARNs still compare and a genuinely out-of-band ARN
  // (matching no sibling) still surfaces.
  if (IAM_ATTACHMENT_REFLECTION_TYPES.has(resourceType)) {
    const sibArns = physicalId ? opts.siblingManagedPolicyAttachments?.[physicalId] : undefined;
    if (sibArns) subtractSiblingManagedPolicyArns(live, sibArns);
    // Subtract from an IAM User's undeclared live `Groups` the memberships added by sibling
    // AWS::IAM::UserToGroupAddition resources (which are themselves CC-gap skipped). Any group
    // added purely out of band (matching no sibling) still surfaces.
    if (resourceType === 'AWS::IAM::User') {
      const sibGroups = physicalId ? opts.siblingUserGroups?.[physicalId] : undefined;
      if (sibGroups) subtractSiblingUserGroups(live, sibGroups);
    }
  }
  // Subtract from an ASG's reflected live `LifecycleHookSpecificationList` the hooks applied by
  // SIBLING standalone AWS::AutoScaling::LifecycleHook resources (keyed by the ASG's physical id in
  // opts.siblingLifecycleHooks). Runs regardless of whether the ASG declares an inline list — only
  // sibling-NAMED hooks are removed, so the ASG's own inline hooks still compare (declared tier) and
  // a hook added purely out of band (matching no sibling) still surfaces. The sibling hook is
  // tracked + compared as its own resource, so leaving it on the ASG double-reports it, is a
  // declared-tier FP that survives record, and a revert would DELETE the sibling-declared hook (#700).
  if (resourceType === 'AWS::AutoScaling::AutoScalingGroup') {
    const sibHooks = physicalId ? opts.siblingLifecycleHooks?.[physicalId] : undefined;
    if (sibHooks) subtractSiblingLifecycleHooks(live, sibHooks);
  }
  // An AWS::EC2::EIP's live `NetworkInterfaceId` reflects the ENI its address is associated with.
  // A LEGITIMATE association is DECLARED by a sibling AWS::EC2::EIPAssociation (or an
  // AWS::EC2::NatGateway consuming the EIP), so drop the reflected id when such a sibling exists —
  // the binding is IaC intent, not drift (the exact eni-… is AWS-assigned at association time, so
  // the fold is presence-gated, keyed by the EIP's identity in opts.siblingEipAssociations). With
  // NO declaring sibling the id is KEPT and surfaces: a live association on an EIP no sibling
  // explains is an out-of-band `associate-address` HIJACK of the allocated static IP (#892), which
  // the old blanket value-independent fold silenced. `NetworkInterfaceId` is only ever present when
  // an association exists (an unassociated EIP has no such key), so no fold is needed when absent.
  // The association can also be SELF-declared on THIS same EIP: a classic `new ec2.CfnEIP({ instanceId })`
  // (or a declared `NetworkInterfaceId`) binds the address to a target, and AWS reflects that target's
  // primary ENI onto the live `NetworkInterfaceId` with NO sibling to explain it (#1261). That
  // reflected id is IaC intent too, so fold it when the EIP declares its own `InstanceId` or
  // `NetworkInterfaceId` — an out-of-band re-associate still surfaces because the declared
  // `InstanceId`/`NetworkInterfaceId` would then mismatch in the declared loop (detection preserved).
  if (resourceType === 'AWS::EC2::EIP' && 'NetworkInterfaceId' in live) {
    const explained =
      (physicalId !== undefined && opts.siblingEipAssociations?.has(physicalId)) ||
      opts.siblingEipAssociations?.has(logicalId);
    const declaresTarget = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
    const selfDeclared =
      declaresTarget(declared.InstanceId) || declaresTarget(declared.NetworkInterfaceId);
    if (explained || selfDeclared) delete live.NetworkInterfaceId;
  }
  // A bucket whose notifications are managed by a Custom::S3BucketNotifications CR reflects
  // the CR-applied NotificationConfiguration it never declares itself (CDK renders
  // addEventNotification/enableEventBridgeNotification as that CR, which cdkrd skips). The
  // config is IaC-managed, not out of band — but only the config the CR ACTUALLY declares.
  // Translate the CR's declared config (S3 API shape) into the live CFn resource shape,
  // canonicalize BOTH sides, and equality-gate: a MATCH (clean deploy) drops the reflected
  // property (no false undeclared drift); a DIFFERENCE means an out-of-band `put-bucket-
  // notification-configuration` added / swapped / removed a target (#1283) — leave the live
  // NotificationConfiguration to surface so the change is caught. Only applies when the
  // template does NOT declare it inline (a raw-CFn bucket that sets NotificationConfiguration
  // directly is compared normally). Fail-safe: on any translation/parse uncertainty the values
  // simply will not match, so we SURFACE rather than silently drop an unverified value.
  if (
    resourceType === 'AWS::S3::Bucket' &&
    physicalId &&
    opts.bucketNotificationManaged?.has(physicalId) &&
    !('NotificationConfiguration' in declared)
  ) {
    const declaredConfig = opts.bucketNotificationConfigs?.[physicalId] ?? {};
    const expectedLive = canonicalizeForCompare(
      canonS3NotifBucketConfig(translateDeclaredBucketNotification(declaredConfig)),
      resourceType
    );
    const actualLive = canonicalizeForCompare(
      canonS3NotifBucketConfig(live.NotificationConfiguration),
      resourceType
    );
    if (deepEqual(expectedLive, actualLive)) delete live.NotificationConfiguration;
  }
  // Drop an UNDECLARED property whose value ECHOES the parent cluster's value (an Aurora
  // DBInstance mirroring its DBCluster's cluster-level config — see CLUSTER_ECHO_CHILD).
  // Equality-gated: a declared property compares normally, and an instance value that
  // DIVERGES from the cluster still surfaces. The parent's own property carries detection.
  const echoSpec = CLUSTER_ECHO_CHILD[resourceType];
  const echoModel = echoSpec && physicalId ? opts.clusterEchoModel?.[physicalId] : undefined;
  if (echoSpec && echoModel) {
    for (const k of Object.keys(live)) {
      if (k in declared) continue;
      const parentKey = echoSpec.aliases[k] ?? k;
      if (!(parentKey in echoModel)) continue;
      const pv = echoModel[parentKey];
      if (deepEqual(live[k], pv) || isStringlyEqualDeep(live[k], pv)) delete live[k];
    }
  }
  // ManagedPolicy attachment lists (Roles/Users/Groups). A DECLARED list is handled
  // per-member in the declared loop below (declared-but-missing = detach; live-only =
  // undeclared inventory). A list the template does NOT declare at all is left in `live`
  // so it flows to the undeclared loop as ordinary undeclared inventory (recordable) —
  // NOT dropped: dropping it hid an unexpected attachment entirely (no record, no later
  // drift). It is inventory, never a positional FP, so it does not reintroduce the
  // cdk-drift union false positive.
  const attachmentProps = IAM_ATTACHMENT_SUBSET[resourceType];
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
  // #652: a SHAPE_ECHO_TWIN source shape is commonly writeOnly (Firehose
  // S3DestinationConfiguration → readGap above), so it is about to be stripped from
  // `declared`. Snapshot the source object(s) the twin echoes BEFORE the strip, so the
  // undeclared-loop twin fold below can still verify + subtract the echo. Only the exact
  // source keys named for THIS type are captured (nothing else is retained).
  const twinSources: Record<string, unknown> = {};
  for (const src of Object.values(SHAPE_ECHO_TWIN[resourceType] ?? {}))
    if (isNestedObject(declared[src])) twinSources[src] = declared[src];
  // #712: an AWS::StepFunctions::StateMachine declared with the OBJECT `Definition` form
  // (writeOnly → readGap, above) reads back only the compiled `DefinitionString` — so the
  // whole live definition otherwise surfaces as undeclared drift on a clean deploy. Snapshot
  // the declared `Definition` object BEFORE the writeOnly strip drops it, so the undeclared
  // loop can fold `DefinitionString` when it parses STRUCTURALLY EQUAL to the declared object
  // (a genuine out-of-band definition change — live != declared — still surfaces).
  const sfnDefinitionObject =
    resourceType === 'AWS::StepFunctions::StateMachine' && isNestedObject(declared['Definition'])
      ? declared['Definition']
      : undefined;
  // #712 (symptom B): `DefinitionSubstitutions` is a writeOnly map of `${token}` → value that
  // CloudFormation applies into the declared `DefinitionString` at deploy time — so the LIVE
  // read echoes the SUBSTITUTED definition while the declared `DefinitionString` still carries
  // the literal `${token}` placeholders. That produces a false [CFn-Declared Drift] that
  // SURVIVES record (record is undeclared-only) and, worse, a `revert` would write the literal
  // `${token}` text back and break the state machine. The substitution is a DETERMINISTIC token
  // replacement (tier-2 derived), so snapshot the map BEFORE the writeOnly strip and apply it to
  // the declared `DefinitionString` below, so declared == live for a clean deploy while a real
  // definition change still surfaces.
  const sfnDefinitionSubstitutions =
    resourceType === 'AWS::StepFunctions::StateMachine' &&
    isNestedObject(declared['DefinitionSubstitutions'])
      ? declared['DefinitionSubstitutions']
      : undefined;
  // writeOnly cannot be read back: strip it from the DECLARED side too so it is never
  // compared (the LIVE side was already stripped by normalizeLiveModel above).
  deepStripPaths(declared, schema.writeOnlyPaths);
  // #712 (symptom B): resolve the snapshotted `DefinitionSubstitutions` into the declared
  // `DefinitionString` (each `${key}` → its value, stringified) BEFORE the declared compare, so
  // the resolved declared string equals the substituted live string. Only literal `${key}`
  // tokens for the declared substitution keys are replaced; any other text is untouched, so an
  // out-of-band edit to the definition body still surfaces as declared drift.
  if (
    sfnDefinitionSubstitutions !== undefined &&
    typeof declared['DefinitionString'] === 'string'
  ) {
    declared['DefinitionString'] = applyDefinitionSubstitutions(
      declared['DefinitionString'],
      sfnDefinitionSubstitutions
    );
  }

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
  let knownDef = KNOWN_DEFAULTS[resourceType] ?? {};
  // #716: an AWS::IAM::AccessKey (now readable via the SDK_OVERRIDES ListAccessKeys reader) whose
  // template omits Status reads back the AWS default Status "Active". Equality-gate it here (a
  // top-level KNOWN_DEFAULTS-equivalent kept in classify.ts so the fold ships with the reader in
  // one lane) so a clean deploy stays CLEAN; an out-of-band flip to "Inactive" (a deactivated key)
  // still surfaces as the drift #716 restores.
  if (resourceType === 'AWS::IAM::AccessKey') {
    knownDef = { ...knownDef, Status: 'Active' };
  }
  // A Redshift RA3 cluster is ALWAYS encrypted (RA3 mandates encryption — it can never be false)
  // and AWS enables AvailabilityZoneRelocation for it by default, so an RA3 cluster that declares
  // neither reads back Encrypted=true / AvailabilityZoneRelocationStatus="enabled" — AWS-forced
  // initial values, not user intent. Fold them via a NodeType conditional (the reliable in-
  // template discriminator; a DC2 cluster keeps the false/absent default and is unaffected).
  // Equality-gated + live-verified on a fresh RA3 single-node deploy. A cluster that declares
  // either value explicitly is compared in the declared loop, never reaching here.
  if (
    resourceType === 'AWS::Redshift::Cluster' &&
    typeof declaredIn?.['NodeType'] === 'string' &&
    (declaredIn['NodeType'] as string).startsWith('ra3')
  ) {
    knownDef = { ...knownDef, Encrypted: true, AvailabilityZoneRelocationStatus: 'enabled' };
  }
  // A TargetGroup's undeclared health-check defaults are a deterministic function of the
  // declared TargetType and ProtocolVersion — a single KNOWN_DEFAULTS constant covers only the
  // HTTP/instance case, so a clean gRPC / instance / lambda group floods first-run potential
  // drift (#648). Derive the per-type default and equality-gate it (a real out-of-band change to
  // any still surfaces). Live-verified across all three variants (hunt 2026-07-08 #648):
  //   - HealthCheckIntervalSeconds: lambda -> 35, else 30.
  //   - HealthCheckPath: GRPC -> "/AWS.ALB/healthcheck", else "/" (only present for HTTP-family
  //     health checks; a TCP group returns none so the default is inert there).
  //   - HealthCheckTimeoutSeconds: lambda -> 30 (the base 5 constant covers instance/ip/gRPC).
  //   - Matcher: GRPC -> {GrpcCode:"12"} (the base {HttpCode:"200"} constant covers the rest).
  //   - HealthyThresholdCount: 5 for every undeclared group.
  // A group that DECLARES any of these carries it in the template and is compared there.
  if (resourceType === 'AWS::ElasticLoadBalancingV2::TargetGroup') {
    const targetType = declaredIn?.['TargetType'];
    // gRPC groups declare ProtocolVersion: GRPC; instance/ip groups read it back HTTP1 from
    // live; a lambda group has neither (so the "/" path default applies).
    const protocolVersion = declaredIn?.['ProtocolVersion'] ?? live['ProtocolVersion'];
    knownDef = {
      ...knownDef,
      HealthyThresholdCount: 5,
      HealthCheckIntervalSeconds: targetType === 'lambda' ? 35 : 30,
      HealthCheckPath: protocolVersion === 'GRPC' ? '/AWS.ALB/healthcheck' : '/',
      ...(targetType === 'lambda' ? { HealthCheckTimeoutSeconds: 30 } : {}),
      ...(protocolVersion === 'GRPC' ? { Matcher: { GrpcCode: '12' } } : {}),
    };
  }
  // #890: an EKS AccessEntry that declares no explicit Username reads back the value EKS
  // DERIVES from the declared PrincipalArn — a DETERMINISTIC transform, not an opaque
  // per-resource id, so it must be a tier-2 derived equality gate (not value-independent):
  // Username is MUTABLE (`eks update-access-entry --username`) and RBAC-load-bearing, so an
  // out-of-band re-map of a principal to a different Kubernetes identity must SURFACE.
  //   - a role principal `arn:<p>:iam::<acct>:role/<path.../name>` derives
  //     `arn:<p>:sts::<acct>:assumed-role/<name>/{{SessionName}}` (iam->sts, role/->
  //     assumed-role/, the path stripped to the bare role name, `/{{SessionName}}` appended);
  //   - any other principal (an IAM user ARN) echoes the PrincipalArn verbatim.
  // Equality-gated: a custom Username the user set is declared and compared in the declared
  // loop; a value that differs from the derived default falls through to `undeclared`.
  if (resourceType === 'AWS::EKS::AccessEntry') {
    const principalArn = declared['PrincipalArn'];
    if (typeof principalArn === 'string') {
      const roleMatch = /^arn:([^:]+):iam::([^:]*):role\/(.+)$/.exec(principalArn);
      let derivedUsername = principalArn;
      if (roleMatch) {
        const partition = roleMatch[1] ?? 'aws';
        const acct = roleMatch[2] ?? '';
        const pathAndName = roleMatch[3] ?? '';
        const roleName = pathAndName.split('/').pop() ?? pathAndName;
        derivedUsername = `arn:${partition}:sts::${acct}:assumed-role/${roleName}/{{SessionName}}`;
      }
      knownDef = { ...knownDef, Username: derivedUsername };
    }
  }
  // AWS/CDK-generated values for THIS resource (its minted name, a default log group
  // derived from the physical id), with the live physical id substituted in — keyed
  // by property, consulted by the undeclared loop below. Empty when the type has no
  // template or the physical id is unknown.
  const genDef = resolveGeneratedDefault(resourceType, physicalId) ?? {};

  // --- Nested-undeclared fold setup + shared emit closure ---------------------------------
  // Used by BOTH the nested descent into DECLARED objects (R96, below) and the descent into a
  // fully-undeclared object listed in DESCEND_UNDECLARED_OBJECT_PATHS (#555). Defined here so
  // the fully-undeclared descend (which runs inside the top-level undeclared loop, earlier than
  // the declared-nested loop) can reuse the exact same leaf classification.
  // R108: KNOWN_DEFAULT_PATHS is the hand-coded twin for the nested service defaults the CFn
  // schema does NOT annotate (the nested analogue of KNOWN_DEFAULTS) — read through the SAME
  // wildcard lookup, equality-gated identically.
  let knownDefPaths = KNOWN_DEFAULT_PATHS[resourceType] ?? {};
  // A Lambda DURABLE FUNCTION (declares DurableConfig — enabling durable execution) runs on
  // AWS's durable/managed compute substrate, which emits structured JSON logs by default
  // (the Durable Execution SDK's default logger always emits JSON), NOT the plain-Text
  // default of a regular function. So a durable function that declares no explicit LogFormat
  // reads back "JSON", which the base `LoggingConfig.LogFormat: 'Text'` default cannot fold
  // and would surface as false undeclared drift. Override the LogFormat default to JSON when
  // DurableConfig is present (the reliable in-template discriminator; the paired
  // ApplicationLogLevel/SystemLogLevel INFO defaults already fold via the base table).
  // Equality-gated + value-independent proof: observed live that DurableConfig <=> JSON on a
  // 9-function stack (same nodejs24.x runtime) where only the durable function reads JSON. A
  // durable function that pins Text explicitly declares it and is compared, never reaching here.
  if (resourceType === 'AWS::Lambda::Function' && 'DurableConfig' in declared) {
    knownDefPaths = { ...knownDefPaths, 'LoggingConfig.LogFormat': 'JSON' };
  }
  // #703: a function's default log group is the DERIVED `/aws/lambda/<name>` (GENERATED_DEFAULTS
  // resolves it, above, via resolveGeneratedDefault). It ALSO sits in GENERATED_NESTED_PATHS as a
  // value-INDEPENDENT nested fold, which shadows the derivation when LoggingConfig is only
  // PARTIALLY declared (e.g. `{ LogFormat: JSON }`) and LogGroup surfaces at sub-key level via
  // emitNested — so an out-of-band log RE-POINT to a custom group was folded and INVISIBLE (a
  // silent FN, and security-relevant: logs land elsewhere while the team watches /aws/lambda/<fn>).
  // Promote it to a tier-2 derived equality gate: fold only the AWS-default value; a custom
  // LogGroup surfaces. The value-independent branch in emitNested is suppressed for any nested
  // path that already has a knownDefPaths gate (the equality gate handles the atDefault case).
  if (resourceType === 'AWS::Lambda::Function') {
    const genLogGroup = (genDef['LoggingConfig'] as Record<string, unknown> | undefined)?.[
      'LogGroup'
    ];
    if (typeof genLogGroup === 'string') {
      knownDefPaths = { ...knownDefPaths, 'LoggingConfig.LogGroup': genLogGroup };
    }
  }
  // #653: a Glue Schema declares its Registry by ARN (Registry.Arn); the live read echoes
  // the registry's NAME (Registry.Name) as an undeclared sub-key — the trailing segment of
  // the declared ARN. Derive the expected name from the declared Registry.Arn tail and
  // equality-gate it (fold tier 2): a schema re-pointed to a different registry surfaces.
  if (resourceType === 'AWS::Glue::Schema') {
    const arn = (declared['Registry'] as Record<string, unknown> | undefined)?.['Arn'];
    if (typeof arn === 'string') {
      const name = arn.split(/[:/]/).pop();
      if (name) knownDefPaths = { ...knownDefPaths, 'Registry.Name': name };
    }
  }
  // #845/#1094: a CodeBuild Project's undeclared `Artifacts.Name` echoes the project name —
  // the declared top-level `Name` when the template declares one, else the AWS-GENERATED
  // project name (= the physical id) when the template declares NO Name (the default CDK
  // `codebuild.Project` without an explicit projectName). Derive from `Name` and fall back to
  // `physicalId`, then equality-gate it (fold tier 2): an out-of-band change of the artifact
  // name away from the project name still surfaces.
  if (resourceType === 'AWS::CodeBuild::Project') {
    const name = declared['Name'];
    const artifactName = typeof name === 'string' ? name : physicalId;
    if (typeof artifactName === 'string') {
      knownDefPaths = { ...knownDefPaths, 'Artifacts.Name': artifactName };
    }
  }
  // #845: a SecretsManager RotationSchedule declaring `RotationRules.ScheduleExpression`
  // "rate(N days)" reads back an undeclared `RotationRules.AutomaticallyAfterDays: N` — AWS
  // mirrors the rate-day count into the legacy scalar. Parse the declared rate and equality-
  // gate the derived day count (fold tier 2): a re-scheduled rotation still surfaces.
  if (resourceType === 'AWS::SecretsManager::RotationSchedule') {
    const expr = (declared['RotationRules'] as Record<string, unknown> | undefined)?.[
      'ScheduleExpression'
    ];
    const m = typeof expr === 'string' ? /^rate\((\d+)\s+days?\)$/.exec(expr.trim()) : null;
    if (m) {
      knownDefPaths = {
        ...knownDefPaths,
        'RotationRules.AutomaticallyAfterDays': Number(m[1]),
      };
    }
  }
  // #845/#1094: an AmazonMQ broker that declares no `StorageType` reads back the AWS default
  // for its engine — ActiveMQ defaults to `EFS`; RabbitMQ supports ONLY `EBS` (DescribeBroker
  // returns storageType unconditionally). Derive the default from the declared `EngineType`
  // and equality-gate it (fold tier 2): a broker that pins a non-default StorageType declares
  // it and is compared, and an out-of-band change away from the derived default still surfaces.
  if (resourceType === 'AWS::AmazonMQ::Broker') {
    const engineType = declared['EngineType'];
    const engineStorageDefault: Record<string, string> = {
      ACTIVEMQ: 'EFS',
      RABBITMQ: 'EBS',
    };
    const storageDefault =
      typeof engineType === 'string' ? engineStorageDefault[engineType.toUpperCase()] : undefined;
    if (storageDefault !== undefined) {
      knownDef = { ...knownDef, StorageType: storageDefault };
    }
  }
  // #975: a CE AnomalySubscription declaring the LEGACY numeric `Threshold` reads back an
  // undeclared `ThresholdExpression` — the service DERIVES a JSON-string expression from it
  // (`{"Dimensions":{"Key":"ANOMALY_TOTAL_IMPACT_ABSOLUTE","MatchOptions":["GREATER_THAN_OR_EQUAL"],
  // "Values":["<Threshold>"]}}`, the Threshold echoed as a decimal string, `5` -> `"5.0"`).
  // Derive the expression from the declared Threshold and equality-gate it (fold tier 2): an
  // out-of-band edit of the expression still surfaces. A subscription that declares
  // ThresholdExpression directly carries it and is compared in the declared loop.
  if (resourceType === 'AWS::CE::AnomalySubscription') {
    const threshold = declared['Threshold'];
    if (typeof threshold === 'number' && Number.isFinite(threshold)) {
      const decimal = Number.isInteger(threshold) ? `${threshold}.0` : String(threshold);
      // The live value is a JSON-STRING prop the normalize pipeline canonicalizes to compact +
      // ALPHABETICALLY-sorted keys, so the object literal below is written in alphabetical key
      // order (Key < MatchOptions < Values) to serialize to the identical string it compares against.
      knownDef = {
        ...knownDef,
        ThresholdExpression: JSON.stringify({
          Dimensions: {
            Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
            MatchOptions: ['GREATER_THAN_OR_EQUAL'],
            Values: [decimal],
          },
        }),
      };
    }
  }
  // #975: an ElastiCache ReplicationGroup with in-transit encryption enabled at creation
  // (`TransitEncryptionEnabled: true`) but no explicit `TransitEncryptionMode` reads back the
  // documented default `"required"` (`"preferred"` is an explicit opt-in). Derive it from the
  // declared flag and equality-gate it (fold tier 2): a group that pins `preferred` declares it
  // and is compared, and an out-of-band flip to `preferred` still surfaces.
  if (
    resourceType === 'AWS::ElastiCache::ReplicationGroup' &&
    declared['TransitEncryptionEnabled'] === true
  ) {
    knownDef = { ...knownDef, TransitEncryptionMode: 'required' };
  }
  // #975: a TransitGatewayRoute / TransitGatewayRouteTableAssociation registry schema ships an
  // EMPTY `readOnly` list, so the schema-strip never removes the primaryIdentifier echo — the
  // undeclared `Id` is an EXACT underscore-join of two DECLARED properties. Derive it and
  // equality-gate it (fold tier 2): the value is a deterministic function of the declared inputs.
  if (resourceType === 'AWS::EC2::TransitGatewayRoute') {
    const rtb = declared['TransitGatewayRouteTableId'];
    const cidr = declared['DestinationCidrBlock'];
    if (typeof rtb === 'string' && typeof cidr === 'string') {
      knownDef = { ...knownDef, Id: `${rtb}_${cidr}` };
    }
  }
  if (resourceType === 'AWS::EC2::TransitGatewayRouteTableAssociation') {
    const attach = declared['TransitGatewayAttachmentId'];
    const rtb = declared['TransitGatewayRouteTableId'];
    if (typeof attach === 'string' && typeof rtb === 'string') {
      knownDef = { ...knownDef, Id: `${attach}_${rtb}` };
    }
  }
  // #975: an AWS::GlobalAccelerator::EndpointGroup that omits HealthCheckPort reads back the port
  // of its LISTENER — AWS resolves the schema's -1 sentinel default ("use the listener port") to
  // the listener's first PortRanges FromPort. The listener is the sibling referenced by the
  // declared ListenerArn; its first port is threaded via opts.siblingListenerPorts (keyed by that
  // ARN, built in gather.ts). Derive + equality-gate it (fold tier 2): a group that pins an
  // explicit HealthCheckPort declares it and is compared, and an out-of-band port change still
  // surfaces. Fail-open: an unresolved ListenerArn / missing sibling leaves the value unfolded.
  if (resourceType === 'AWS::GlobalAccelerator::EndpointGroup') {
    const listenerArn = declared['ListenerArn'];
    const port =
      typeof listenerArn === 'string' ? opts.siblingListenerPorts?.[listenerArn] : undefined;
    if (typeof port === 'number') {
      knownDef = { ...knownDef, HealthCheckPort: port };
    }
  }
  // #701: an EventSourceMapping's default BatchSize depends on the source service — 10 for
  // SQS, 100 for Kinesis / DynamoDB streams / MSK / Kafka. Derive the expected default from
  // the declared EventSourceArn's service segment (arn:<p>:<service>:...) and equality-gate
  // it (fold tier 2): a mapping that pins a custom batch size still surfaces. (An unknown /
  // self-managed source leaves BatchSize unfolded so it never wrongly folds.)
  if (resourceType === 'AWS::Lambda::EventSourceMapping') {
    const arn = declared['EventSourceArn'];
    const service = typeof arn === 'string' ? arn.split(':')[2] : undefined;
    const batchDefault =
      service === 'sqs'
        ? 10
        : service === 'kinesis' || service === 'dynamodb' || service === 'kafka'
          ? 100
          : undefined;
    if (batchDefault !== undefined) knownDef = { ...knownDef, BatchSize: batchDefault };
  }
  // #701: a KMS key that declares no KeyPolicy (optional in CFn since 2021; raw-CFn users
  // omit it, CDK always emits it) reads back the DEFAULT root-access policy — a single
  // "Enable IAM User Permissions" statement granting kms:* to the account root. It is a
  // deterministic function of the account id (fold tier 2). Policy canonicalization strips
  // the Sid / Id, so the compared shape is the single {Effect,Principal,Action,Resource}
  // statement (matching the KMS corpus). A policy scoped to anything else still surfaces.
  if (resourceType === 'AWS::KMS::Key' && opts.accountId !== undefined) {
    // Derive the partition from the single canonical helper so every partition it supports
    // (incl. the four ISO partitions) folds identically (#945). Unknown region → `aws` (as before).
    const partition = opts.region !== undefined ? partitionForRegion(opts.region).partition : 'aws';
    // Build the RAW default policy and run it through the SAME canonicalization the live
    // side gets, so the two match regardless of canonicalization details (array-wrapping,
    // root-ARN reduction to the account id, key ordering).
    knownDef = {
      ...knownDef,
      KeyPolicy: canonicalizePolicy({
        Version: '2012-10-17',
        Id: 'key-default-1',
        Statement: [
          {
            Sid: 'Enable IAM User Permissions',
            Effect: 'Allow',
            Principal: { AWS: `arn:${partition}:iam::${opts.accountId}:root` },
            Action: 'kms:*',
            Resource: '*',
          },
        ],
      }),
    };
  }
  // #678: a PRIVATE RestApi (declared EndpointConfiguration.Types includes 'PRIVATE') gets
  // DIFFERENT AWS defaults than an EDGE/REGIONAL api — SecurityPolicy TLS_1_2 (not TLS_1_0)
  // and EndpointConfiguration.IpAddressType 'dualstack' (not 'ipv4'), both live-verified.
  // Derive the expected default from the declared endpoint type and equality-gate it (fold
  // tier 2): an out-of-band flip of either value away from the PRIVATE default still
  // surfaces. The base EDGE/REGIONAL constants stay for the other endpoint types.
  if (resourceType === 'AWS::ApiGateway::RestApi') {
    const types = (declared['EndpointConfiguration'] as Record<string, unknown> | undefined)?.[
      'Types'
    ];
    if (Array.isArray(types) && types.includes('PRIVATE')) {
      knownDef = { ...knownDef, SecurityPolicy: 'TLS_1_2' };
      knownDefPaths = { ...knownDefPaths, 'EndpointConfiguration.IpAddressType': 'dualstack' };
    }
    // #676: expand the declared resource policy's `execute-api:/...` shorthand to the ARN the
    // service echoes back, so a clean private (or any) api with the documented shorthand policy
    // does not false-drift on every statement. Re-canonicalize so the expanded Resource arrays
    // sort identically to the live side. Needs the api id (physicalId) + account + region.
    // #839: only expand a RESOLVED policy. When declared['Policy'] is the UNRESOLVED symbol
    // (an unresolved Fn::If / Fn::Sub / {{resolve:...}} dynamic reference) — or an object still
    // carrying it — it is truthy but NOT a real policy. Running canonicalizePolicy on it spreads
    // the symbol away (`{...symbol}` → `{ Statement: [null] }`), destroying the UNRESOLVED marker
    // and manufacturing a false `declared` Policy.Statement drift (desired:[null]) plus a false
    // `undeclared` Policy.Version — and a revert would write `[null]` to the live policy. Skip the
    // expansion so the normal path yields the single benign `unresolved`-tier Policy finding.
    if (
      physicalId &&
      opts.accountId !== undefined &&
      declared['Policy'] &&
      declared['Policy'] !== UNRESOLVED &&
      !hasUnresolved(declared['Policy'])
    ) {
      // Canonical partition helper (#945): folds ISO partitions too. Unknown region → `aws`.
      const partition =
        opts.region !== undefined ? partitionForRegion(opts.region).partition : 'aws';
      const arnPrefix = `arn:${partition}:execute-api:${opts.region ?? ''}:${opts.accountId}:${physicalId}`;
      declared['Policy'] = canonicalizePolicy(
        expandExecuteApiResources(declared['Policy'], arnPrefix) as Record<string, unknown>
      );
    }
  }
  // #642: a UserPool's undeclared AdminCreateUserConfig.UnusedAccountValidityDays is
  // Cognito's legacy alias that always MIRRORS the declared
  // Policies.PasswordPolicy.TemporaryPasswordValidityDays (7 when that too is unset). The
  // base KNOWN_DEFAULT_PATHS pins the constant 7, so a pool declaring a non-7 temp-password
  // lifetime false-drifts. Derive the expected value from the declared sibling and
  // equality-gate it (fold tier 2): an out-of-band change still surfaces.
  if (resourceType === 'AWS::Cognito::UserPool') {
    const tpvd = (
      (declared['Policies'] as Record<string, unknown> | undefined)?.['PasswordPolicy'] as
        | Record<string, unknown>
        | undefined
    )?.['TemporaryPasswordValidityDays'];
    knownDefPaths = {
      ...knownDefPaths,
      'AdminCreateUserConfig.UnusedAccountValidityDays': tpvd ?? 7,
    };
  }
  // #643: a ResourceDataSync declares its destination NESTED (S3Destination.*), but the live
  // read ALSO echoes BucketName / BucketRegion / SyncFormat as TOP-LEVEL twins (the schema's
  // legacy flat shape). Fold each undeclared top-level twin against the declared S3Destination
  // sibling (fold tier 2, equality-gated): a genuinely retargeted destination still surfaces.
  if (resourceType === 'AWS::SSM::ResourceDataSync') {
    const s3 = declared['S3Destination'] as Record<string, unknown> | undefined;
    if (s3 && typeof s3 === 'object') {
      const twins: Record<string, unknown> = {};
      for (const key of ['BucketName', 'BucketRegion', 'SyncFormat'] as const) {
        if (key in s3) twins[key] = s3[key];
      }
      knownDef = { ...knownDef, ...twins };
    }
  }
  // #640: an EC2 Instance on a BURSTABLE (T-family) InstanceType reads back an undeclared
  // CreditSpecification.CPUCredits whose default depends on the family — the T2 family
  // defaults to "standard", every later burstable family (t3 / t3a / t4g) defaults to
  // "unlimited". Derive the expected default from the declared InstanceType family and
  // equality-gate the whole {CPUCredits} object (fold tier 2): a user who pins the other
  // credit mode still surfaces. Non-burstable families carry no CreditSpecification, so
  // leave the default unset there (nothing to fold).
  if (resourceType === 'AWS::EC2::Instance') {
    const instanceType = declared['InstanceType'];
    const family = typeof instanceType === 'string' ? instanceType.split('.')[0] : undefined;
    const creditDefault =
      family === 't2'
        ? 'standard'
        : family === 't3' || family === 't3a' || family === 't4g'
          ? 'unlimited'
          : undefined;
    if (creditDefault !== undefined) {
      knownDef = { ...knownDef, CreditSpecification: { CPUCredits: creditDefault } };
    }
  }
  // #640: a gp2 EBS Volume (declared VolumeType "gp2", or omitted — gp2 is the AWS default)
  // reads back an undeclared baseline Iops that AWS computes from the declared Size:
  // 3 IOPS/GiB, clamped to [100, 16000]. Derive that baseline and equality-gate it (fold
  // tier 2): a user who bumps Iops still surfaces. gp3 / io1 / io2 declare Iops explicitly
  // and are compared in the declared loop, so only gate the gp2 case.
  if (resourceType === 'AWS::EC2::Volume') {
    const volumeType = declared['VolumeType'] ?? 'gp2';
    const size = declared['Size'];
    if (volumeType === 'gp2' && typeof size === 'number') {
      knownDef = { ...knownDef, Iops: Math.min(16000, Math.max(100, 3 * size)) };
    }
  }
  // #640: an EC2 NetworkInterface that declares a PrivateIpAddresses list reads back an
  // undeclared SecondaryPrivateIpAddressCount = all-but-the-primary of that list, i.e.
  // max(0, len - 1). Derive it from the declared list and equality-gate it (fold tier 2):
  // an out-of-band change to the secondary-IP count still surfaces.
  if (resourceType === 'AWS::EC2::NetworkInterface') {
    const ips = declared['PrivateIpAddresses'];
    if (Array.isArray(ips)) {
      knownDef = { ...knownDef, SecondaryPrivateIpAddressCount: Math.max(0, ips.length - 1) };
    }
  }
  // #894: a Stage that declares a CanarySetting reads back an undeclared
  // `CanarySetting.DeploymentId` AWS materializes at creation — the canary starts pointed at the
  // stage's CURRENT deployment, so it EQUALS the stage's own `DeploymentId` (declared, or the live
  // value when omitted). Previously folded value-INDEPENDENT via GENERATED_NESTED_PATHS, which hid
  // an out-of-band canary re-point (`update-stage /canarySettings/deploymentId`) — re-aiming the
  // canary at an old/vulnerable deployment serves that code to the canary % of prod traffic,
  // invisibly. Promote to a tier-2 derived equality gate against the stage's own DeploymentId
  // (declared wins; else the live top-level value). The value-independent GENERATED_NESTED_PATHS
  // branch in emitNested is suppressed for any nested path that has a knownDefPaths gate this run,
  // so a re-pointed canary now surfaces while a clean deploy stays atDefault.
  if (resourceType === 'AWS::ApiGateway::Stage') {
    const stageDeploymentId = declared['DeploymentId'] ?? live['DeploymentId'];
    if (typeof stageDeploymentId === 'string') {
      knownDefPaths = { ...knownDefPaths, 'CanarySetting.DeploymentId': stageDeploymentId };
    }
  }
  // #894: a VPCEndpoint that declares no `DnsOptions` reads back an AWS-assigned default object
  // whose `DnsRecordIpType` is a DETERMINISTIC function of the declared `VpcEndpointType`
  // ("ipv4" for an Interface endpoint, "service-defined" for a Gateway one); the other sub-keys
  // are stable constants. Previously folded value-INDEPENDENT (whole object) via
  // VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS, which hid an out-of-band `ModifyVpcEndpoint` edit of
  // any sub-key. Derive the full default object from VpcEndpointType and equality-gate it (fold
  // tier 2, subset-tolerant): a clean deploy stays atDefault, an out-of-band change to any sub-key
  // (e.g. a DnsRecordIpType flip) surfaces. A user who configures DNS DECLARES DnsOptions and is
  // compared in the declared loop, never reaching here.
  if (resourceType === 'AWS::EC2::VPCEndpoint') {
    const epType = declared['VpcEndpointType'];
    const dnsRecordIpType =
      epType === 'Interface' ? 'ipv4' : epType === 'Gateway' ? 'service-defined' : undefined;
    if (dnsRecordIpType !== undefined) {
      knownDef = {
        ...knownDef,
        DnsOptions: {
          DnsRecordIpType: dnsRecordIpType,
          PrivateDnsOnlyForInboundResolverEndpoint: 'NotSpecified',
          PrivateDnsSpecifiedDomains: ['*'],
          PrivateDnsPreference: 'VERIFIED_DOMAINS_ONLY',
        },
      };
    }
  }
  // R140: nested paths that are always an AWS-assigned generated id (value-independent),
  // folded as `generated` like the top-level isGeneratedName/GENERATED_DEFAULTS cases.
  const generatedPaths = GENERATED_PATHS[resourceType] ?? [];
  const generatedNestedPaths = GENERATED_NESTED_PATHS[resourceType];
  // Schema-detected FREE-FORM MAP properties (Lambda Environment.Variables, Glue
  // Parameters): a live-only sub-key directly under one is user-authored data, not an
  // AWS-materialized nested default — so flag it `freeFormKey` to surface it in the report
  // (the generic nested fold would hide a console-added env var as first-run noise).
  const freeFormMapPaths = schema.freeFormMapPaths ?? [];
  const underFreeFormMap = (schemaPath: string): boolean =>
    freeFormMapPaths.some((ff) => schemaPath.startsWith(`${ff}.`));
  const emitNested = (path: string, value: unknown): void => {
    if (isTrivialEmpty(value)) return;
    // #863: `isAllAwsTags` matches two shapes — an ARRAY of `{Key:'aws:*'}` (an unambiguous
    // tag LIST: AWS-managed system tags, always safe to drop) and an OBJECT whose keys are
    // all `aws:*` (a MAP-shaped tag, e.g. UserPoolTags — BUT ALSO an IAM policy Condition
    // OPERATOR map like `{aws:SourceAccount: ...}`). Dropping the object form unconditionally
    // (no parent-key gate — the R69 confusion `stripAwsTagsDeep` already fixed) hid an
    // out-of-band Condition operator added under a declared statement: a security FN that
    // survived `record`. Gate the object form on the parent key being a tag property
    // (`*Tags`); the array form still drops unconditionally.
    if (isAllAwsTags(value)) {
      const isObjectForm = value !== null && typeof value === 'object' && !Array.isArray(value);
      const parentKey = (path.split('.').pop() ?? '').replace(/\[.*$/, '');
      if (!isObjectForm || /tags$/i.test(parentKey)) return;
    }
    const schemaPath = path.replace(/\[[^\]]*\]/g, '.*');
    // Same subset-tolerant default match as the top-level atDefault compare: an
    // OBJECT-valued nested default (CloudFront GeoRestriction, Scheduler RetryPolicy,
    // Cognito SignInPolicy, …) that AWS returns with a sub-key omitted still folds,
    // while a sub-key changed away from the default — or an extra key — surfaces.
    // Falls back to deepEqual for scalars/arrays, so nothing else changes.
    const atDefault =
      (schemaPath in schema.defaultPaths &&
        matchesKnownDefault(value, schema.defaultPaths[schemaPath])) ||
      (schemaPath in knownDefPaths && matchesKnownDefault(value, knownDefPaths[schemaPath])) ||
      // #979: a nested undeclared value equal to ONE OF a small closed set of stable-constant
      // AWS defaults (the EKS ServiceIpv4Cidr's two documented CIDRs) — the nested twin of the
      // top-level KNOWN_DEFAULT_ONE_OF, still equality-gated (a value outside the set surfaces).
      (KNOWN_DEFAULT_ONE_OF_PATHS[resourceType]?.[schemaPath]?.some((d) =>
        matchesKnownDefault(value, d)
      ) ??
        false) ||
      // #627: a GSI's undeclared WarmThroughput echoing that GSI's effective capacity
      // (on-demand constant or its own ProvisionedThroughput) — a per-GSI derived default.
      dynamoGsiWarmThroughputAtDefault(resourceType, path, value, live) ||
      // #1314: an AWS::Events::EventBusPolicy's live `Statement[n].Sid` (the resource's OWN
      // read) is the service stamping the declared top-level `StatementId` into the stored
      // statement — the registry `propertyTransform` `Statement: $merge([{"Sid":StatementId},
      // Statement])`. That transform gate (#881) only runs in the DECLARED loop, so when the
      // template omits `Sid` on `Statement`, this live-only value lands here as nested-
      // undeclared inventory (Statement[0].Sid) and floods a first-run FP on EVERY policy.
      // Tier-2 DERIVED fold: equality-gate the live Sid against the declared StatementId — a
      // Sid that DIFFERS (a real out-of-band statement swap) still surfaces (detection preserved).
      // This is the policy's own read; the sibling-EventBus reflection (#699) is a separate path.
      (resourceType === 'AWS::Events::EventBusPolicy' &&
        schemaPath === 'Statement.*.Sid' &&
        typeof value === 'string' &&
        value === declared['StatementId']);
    const tier = atDefault
      ? 'atDefault'
      : // R142: a GENERATED_PATHS value folds as `generated` ONLY when it echoes a
        // physical-id segment (the AWS default) — a custom value the user set surfaces.
        (generatedPaths.includes(schemaPath) && isPhysicalIdSegment(value, physicalId)) ||
          // Value-INDEPENDENT nested generated path (KMS KeyPolicy.Id): AWS/CFn-injected,
          // never derivable from the physical id — folded only in this live-only case. But NOT
          // when the path also has a knownDefPaths equality gate this run (#703 Lambda
          // LoggingConfig.LogGroup, derived above): the gate already folded the AWS-default
          // value via `atDefault`, so a value reaching here is a real custom one that must
          // surface, not be value-independent-folded.
          // #704: a managed-service-KEY nested path (DynamoDB SSESpecification.KMSMasterKeyId,
          // OpenSearch EncryptionAtRestOptions.KmsKeyId) is value-independent ONLY for the
          // account/region AWS-managed key (`alias/aws/<service>`); a CMK swapped in out of
          // band (a MUTABLE, security-relevant change) must surface. Gate the fold against the
          // resolved managed key — fail OPEN (keep folding) when the alias can't be resolved.
          (generatedNestedPaths?.has(schemaPath) &&
            !(schemaPath in knownDefPaths) &&
            (!(schemaPath in (MANAGED_KEY_ALIAS_PATHS[resourceType] ?? {})) ||
              shouldFoldManagedServiceKey(resourceType, schemaPath, value, opts.kmsAliasTargets)))
        ? 'generated'
        : 'undeclared';
    // A free-form map key surfaces (not folded), but only when it is a real undeclared
    // value — an atDefault/generated one stays informational like any other.
    const freeFormKey = tier === 'undeclared' && underFreeFormMap(schemaPath);
    findings.push({
      tier,
      logicalId,
      resourceType,
      path,
      actual: value,
      nested: true,
      ...(freeFormKey && { freeFormKey: true }),
    });
  };
  // #624 (general, fail-closed): true when a FULLY-undeclared OBJECT is entirely AWS-materialized
  // defaults — every scalar leaf equality-matches the schema's nested `default` (schema.defaultPaths)
  // or the hand-coded KNOWN_DEFAULT_PATHS twin, and any empty sub-value is trivially empty. A single
  // leaf that is a real (non-default) value — or an ARRAY, which this rule does not attempt to fold —
  // makes it false, so the whole object surfaces. Lets a fully-undeclared object whose only leaves are
  // schema-annotated defaults (e.g. KinesisVideo StreamStorageConfiguration `{DefaultStorageTier:"HOT"}`)
  // fold whole atDefault WITHOUT a per-type DESCEND_UNDECLARED_OBJECT_PATHS entry.
  const allLeavesAtSchemaDefault = (value: unknown, basePath: string): boolean => {
    if (isTrivialEmpty(value)) return true;
    if (Array.isArray(value)) return false;
    if (isNestedObject(value))
      return Object.entries(value).every(([sk, sv]) =>
        allLeavesAtSchemaDefault(sv, `${basePath}.${sk}`)
      );
    const schemaPath = basePath.replace(/\[[^\]]*\]/g, '.*');
    return (
      (schemaPath in schema.defaultPaths &&
        matchesKnownDefault(value, schema.defaultPaths[schemaPath])) ||
      (schemaPath in knownDefPaths && matchesKnownDefault(value, knownDefPaths[schemaPath]))
    );
  };
  // ----------------------------------------------------------------------------------------

  // #849: top-level exempted props whose SDK_SUPPLEMENTS read failed (router.ts). They are
  // absent from `live` because the read could not verify them, not because the resource lacks
  // them — so a DECLARED one must surface as a `readGap` (never a false declared removal, #752)
  // and an UNDECLARED one as a `readGap` too (an out-of-band value on it is unread, not clean).
  const supplementReadGap = new Set(opts.supplementReadGapPaths ?? []);
  // Gap #2: an UNDECLARED exempted prop whose supplement read failed has no declared value to
  // drive the loop below, so surface its unread-ness here. (A declared one is handled inside the
  // loop's `!(k in live)` branch; a prop the CC read genuinely echoed is present in live — skip.)
  for (const p of supplementReadGap) {
    if (!(p in declared) && !(p in live)) {
      findings.push({
        tier: 'readGap',
        logicalId,
        resourceType,
        path: p,
        note: 'supplement read failed — property unverifiable (grant the missing read permission)',
      });
    }
  }

  for (const [k, v] of Object.entries(declared)) {
    if (v === UNRESOLVED || hasUnresolved(v)) {
      findings.push({ tier: 'unresolved', logicalId, resourceType, path: k });
      // Wholly unresolved, OR partially unresolved but not in live to compare against:
      // nothing more to do. Otherwise fall through to compare the RESOLVED sub-values —
      // a sibling sub-value's drift (e.g. a changed Environment.Variables entry next to a
      // GetAtt-valued one) must not be hidden just because a SIBLING leaf is unresolved.
      // The compare below skips any per-leaf record whose declared side is unresolved.
      if (v === UNRESOLVED || !(k in live)) continue;
    } else if (!(k in live)) {
      // #849: a declared exempted prop whose supplement read FAILED — absent from live because
      // it could not be verified, NOT because it was removed. Surface it as a counted readGap
      // (never a false `declared` removal, whatever its shape) and skip the shape heuristics.
      if (supplementReadGap.has(k)) {
        findings.push({
          tier: 'readGap',
          logicalId,
          resourceType,
          path: k,
          note: 'supplement read failed — property unverifiable (grant the missing read permission)',
        });
        continue;
      }
      // A declared key absent from the live read. A declared NON-EMPTY COLLECTION
      // (object/array) absent from live means the whole config was emptied/removed out
      // of band — many services OMIT a sub-config entirely when empty but RETURN it
      // when set (SecurityGroup ingress/egress, IAM inline Policies, every S3 sub-config,
      // Lambda Environment, …). Treating that as an informational readGap was a SILENT
      // FALSE NEGATIVE (the removal reported CLEAN). So DETECT it by default — emit ONE
      // WHOLE-PROPERTY declared finding (revert then re-applies the entire config via a
      // single top-level `add`; a nested sub-path patch fails because the parent, e.g.
      // `/CorsConfiguration`, is absent in the live model). FP-safe: a populated
      // collection is always returned by AWS, so this only fires on a genuine removal.
      //
      // EXCEPTIONS stay readGap (informational, never false drift): a SCALAR (AWS may
      // legitimately not echo a scalar), an EMPTY declared collection (declared `{}`/`[]`
      // vs absent is not drift), and the curated READGAP_COLLECTION_PATHS denylist —
      // collections AWS genuinely never returns even when set (Batch Timeout, DynamoDB
      // SSESpecification, Budgets NotificationsWithSubscribers). A new genuine readGap
      // surfaces as a VISIBLE, denylist-able false positive, never a silent FN.
      const isNonEmptyCollection =
        (Array.isArray(v) && v.length > 0) ||
        (v !== null && typeof v === 'object' && Object.keys(v as object).length > 0);
      // #507: a declared SCALAR on a curated SCALAR_RETURNED_WHEN_SET path — proven to
      // be echoed by the live read when set — that is absent from live was cleared out
      // of band (replace-omit update semantics). Detect it like a removed collection
      // (whole-property `add` on revert). A non-empty string / boolean / number counts
      // as "set"; a declared empty string stays readGap (declared `""` vs absent is not
      // drift).
      const isClearedAllowlistedScalar =
        SCALAR_RETURNED_WHEN_SET[resourceType]?.has(k) === true &&
        ((typeof v === 'string' && v.length > 0) ||
          typeof v === 'number' ||
          typeof v === 'boolean');
      if (
        (isNonEmptyCollection && !READGAP_COLLECTION_PATHS[resourceType]?.has(k)) ||
        isClearedAllowlistedScalar
      ) {
        pushDeclaredFinding(findings, {
          logicalId,
          resourceType,
          path: k,
          desired: v,
          actual: undefined,
        });
      } else {
        findings.push({
          tier: 'readGap',
          logicalId,
          resourceType,
          path: k,
          note: 'declared but not returned by live read',
        });
      }
      continue;
    }
    // #712: an AWS::StepFunctions::StateMachine's `DefinitionString` is a JSON document the
    // service re-serializes (pretty-printed) on read, so the declared compact JSON and the live
    // pretty-printed JSON are never BYTE-equal even for a clean deploy — the plain string compare
    // below would false-flag every state machine. Compare the two STRUCTURALLY (parse both, then
    // deepEqual, order-insensitive per the pipeline). The declared side already carries any
    // `DefinitionSubstitutions` resolved in above (symptom B), so a clean deploy — whether
    // declared with the string form, the string+substitutions form, or the object form (whose
    // `DefinitionString` the live read supplies) — folds; a genuine out-of-band edit to the state
    // machine body still fails the structural compare and surfaces as one declared finding at `k`.
    if (
      resourceType === 'AWS::StepFunctions::StateMachine' &&
      k === 'DefinitionString' &&
      typeof v === 'string' &&
      typeof live[k] === 'string'
    ) {
      let declaredParsed: unknown;
      let liveParsed: unknown;
      try {
        declaredParsed = JSON.parse(v);
        liveParsed = JSON.parse(live[k] as string);
      } catch {
        declaredParsed = undefined;
      }
      if (declaredParsed !== undefined && deepEqual(declaredParsed, liveParsed)) continue;
      // GetTemplate masks every non-ASCII character in a stored string literal as `?`
      // (see isCfnTemplateNonAsciiMask), so a definition carrying non-ASCII text (a
      // Japanese `Cause` message) arrives corrupted on the DECLARED side while the live
      // read is intact — the structural compare above can never match, and pushing the
      // declared finding here would bypass the general mask→readGap demotion the plain
      // string-diff path applies. When the two definitions differ ONLY at such masked
      // leaves, the declared value is unknowable from GetTemplate (CloudFormation itself
      // reports it IN_SYNC), so surface a readGap instead of a false drift; a genuine
      // out-of-band edit still fails the mask-tolerant compare and is reported.
      if (
        (declaredParsed !== undefined && deepEqualModuloNonAsciiMask(declaredParsed, liveParsed)) ||
        isCfnTemplateNonAsciiMask(v, live[k])
      ) {
        findings.push({
          tier: 'readGap',
          logicalId,
          resourceType,
          path: k,
          note: GETTEMPLATE_MASK_NOTE,
        });
        continue;
      }
      pushDeclaredFinding(findings, {
        logicalId,
        resourceType,
        path: k,
        desired: v,
        actual: live[k],
      });
      continue;
    }
    // #503: a JSON-STRING property into which the service INJECTS a constant default member
    // the template never sent (CE CostCategory `Rules` gets `"Type":"REGULAR"` per rule).
    // Both sides arrive as canonicalized JSON strings, so the plain string compare below
    // false-flags the injected member as permanent declared drift (and revert can never
    // converge — the re-read re-injects it). This prop is NOT in JSON_STRING_PROPS (its
    // revert works via a plain Cloud Control whole-prop replace), so fold it HERE: parse
    // both sides, subtract the service-injected defaults from live where the declared side
    // omits them and the value equals the default, and skip if the remainder matches. A
    // genuine change (a member set to a non-default value) does NOT match and falls through
    // to the normal compare below, reported with the full live state.
    const jsonFills = JSON_STRING_DEFAULT_FILLS[resourceType]?.[k];
    if (jsonFills !== undefined && typeof v === 'string' && typeof live[k] === 'string') {
      try {
        const dvParsed = JSON.parse(v) as unknown;
        const lvStripped = stripInjectedJsonStringDefaults(
          dvParsed,
          JSON.parse(live[k] as string),
          jsonFills
        );
        if (deepEqual(dvParsed, lvStripped) || isStringlyEqualDeep(dvParsed, lvStripped)) continue;
      } catch {
        /* not JSON on one side — fall through to the normal compare */
      }
    }
    // A CloudFormation JSON-STRING property (AWS::Config::ConfigRule InputParameters):
    // the schema types it as a string holding JSON, but CDK declares it as an object and
    // the live read returns it parsed. Compare and emit it as a WHOLE UNIT at the
    // top-level path — never descend — so the revert rewrites the whole property as a
    // compact JSON string (a sub-path RFC6902 patch makes Cloud Control re-serialize the
    // JSON in a shape the provider rejects; see JSON_STRING_PROPS). Fold a stringly-equal
    // value (declared `90` vs live `"90"`, the param-values-are-strings coercion) so a
    // clean deploy is not drift; a genuine value change is one declared finding at `k`.
    if (JSON_STRING_PROPS[resourceType]?.has(k)) {
      // Parse a side that arrives as a raw JSON string (some providers return the
      // property unparsed) so both forms compare structurally; then fold a stringly-equal
      // value (declared `90` vs live `"90"`). A genuine value change is one declared
      // finding at the whole property path.
      const parseJson = (x: unknown): unknown => {
        if (typeof x !== 'string') return x;
        try {
          return JSON.parse(x) as unknown;
        } catch {
          return x;
        }
      };
      const dv = parseJson(v);
      const lv = parseJson(live[k]);
      if (!deepEqual(dv, lv) && !isStringlyEqualDeep(dv, lv)) {
        // Same GetTemplate `?`-mask bypass as the SFN DefinitionString branch above
        // (#1247): the declared side arrives with every non-ASCII character in a string
        // literal masked to `?` while the live read is intact, and pushing here would
        // skip the general mask→readGap demotion the plain string-diff path applies.
        // When the parsed documents differ ONLY at masked string leaves, the declared
        // value is unknowable from GetTemplate — a readGap, not drift; a genuine edit
        // still fails the mask-tolerant compare and is reported.
        if (deepEqualModuloNonAsciiMask(dv, lv)) {
          findings.push({
            tier: 'readGap',
            logicalId,
            resourceType,
            path: k,
            note: GETTEMPLATE_MASK_NOTE,
          });
          continue;
        }
        pushDeclaredFinding(findings, {
          logicalId,
          resourceType,
          path: k,
          desired: v,
          actual: live[k],
        });
      }
      continue;
    }
    // ManagedPolicy attachment lists (Roles/Users/Groups): tier each member by WHO
    // declared it. A DECLARED member absent from the live (union) set is an out-of-band
    // DETACH — emit a declared finding per missing member, carrying the member on
    // `attributeKey` so revert re-attaches ONLY that one (never rewriting the whole
    // list, which would detach the union members another stack/role legitimately added).
    // A live member NOT declared is the union — emit it as nested UNDECLARED inventory
    // (recordable), NOT a positional FP: a known union member folds/records, and a NEW
    // unexpected attachment then surfaces as drift vs the baseline. An unresolved
    // declared member (an intrinsic the synth couldn't resolve) can't be compared —
    // skip it (the whole-property `unresolved` finding above already noted it).
    if (attachmentProps?.has(k) && Array.isArray(v) && Array.isArray(live[k])) {
      const liveArr = live[k] as unknown[];
      const liveSet = new Set(liveArr.map((m) => String(m)));
      const declaredSet = new Set<string>();
      for (const member of v) {
        if (member === UNRESOLVED || hasUnresolved(member)) continue;
        if (typeof member !== 'string' && typeof member !== 'number') continue;
        declaredSet.add(String(member));
        if (liveSet.has(String(member))) continue;
        pushDeclaredFinding(findings, {
          logicalId,
          resourceType,
          path: k,
          attributeKey: String(member),
          desired: member,
          actual: undefined,
          note: 'declared attachment not present in live (out-of-band detach)',
        });
      }
      for (const member of liveArr) {
        if (typeof member !== 'string' && typeof member !== 'number') continue;
        if (declaredSet.has(String(member))) continue;
        findings.push({
          tier: 'undeclared',
          logicalId,
          resourceType,
          path: `${k}[${String(member)}]`,
          actual: member,
          nested: true,
        });
      }
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
        // an unresolved declared attribute value can't be compared (already noted at the
        // property level) — skip it rather than emit a false declared drift vs the symbol
        if (dEl.Value === UNRESOLVED || hasUnresolved(dEl.Value)) continue;
        const lEl = liveBag.find((e) => isKeyValueEntry(e) && e.Key === dEl.Key);
        const liveValue = lEl ? (lEl as { Value: unknown }).Value : undefined;
        if (deepEqual(dEl.Value, liveValue)) continue;
        if (isStringlyEqualScalar(dEl.Value, liveValue)) continue;
        pushDeclaredFinding(findings, {
          logicalId,
          resourceType,
          path: k,
          attributeKey: dEl.Key,
          desired: dEl.Value,
          actual: liveValue,
        });
      }
      // Fail-closed (R95): the live bag also carries attribute keys the template never
      // declared (the ~20 server-default LB/TG attributes, OR an out-of-band custom
      // attribute). The declared loop above compares ONLY declared keys, so without this
      // the undeclared keys reached NO dimension — not even `record` — making an
      // out-of-band change to an UNDECLARED attribute (routing.http2.enabled,
      // deletion_protection.enabled, access_logs.s3.enabled …) a permanent silent FN,
      // contradicting cdkrd's core undeclared-property promise. Emit each live-only key as
      // nested undeclared inventory — the same fail-closed treatment R95 gives every other
      // identity-keyed array: folded as informational on the first run, snapshotted by
      // `record`, and a later change vs the baseline then surfaces as real drift. A
      // live-only key whose value EQUALS its curated AWS default (ELB_ATTRIBUTE_DEFAULTS)
      // is instead surfaced in the `atDefault` tier: still inventory (never drift), but it
      // shrinks the first-run `[Potential Drift]` noise the ~15-20 server-default attributes
      // otherwise produce. This is a CURATED per-KEY equality-gated fold, NOT the wildcard
      // an earlier revision warned against — a key absent from the table, or present with a
      // non-default value, still classifies `undeclared` and is recorded, so a real
      // out-of-band change never hides.
      const declaredKeys = new Set(
        v.filter(isKeyValueEntry).map((e) => (e as { Key: string }).Key)
      );
      // A LoadBalancer's per-type defaults (NLB/GWLB cross_zone "false") override the
      // shared table — the live `Type` is authoritative (readable, createOnly), with
      // the omitted-Type default `application` as the fallback.
      const lbType =
        resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer'
          ? String(live.Type ?? declared.Type ?? 'application')
          : undefined;
      const attrDefaults = {
        ...(ELB_ATTRIBUTE_DEFAULTS[resourceType] ?? {}),
        ...(lbType === undefined ? {} : (ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE[lbType] ?? {})),
      };
      for (const lEl of liveBag) {
        if (!isKeyValueEntry(lEl)) continue;
        const key = (lEl as { Key: string }).Key;
        if (declaredKeys.has(key)) continue;
        const value = (lEl as { Value: unknown }).Value;
        if (isTrivialEmpty(value)) continue;
        // bag values are stringly; match an equal string directly, and also tolerate a
        // typed live scalar (boolean/number) echoed against the string default.
        const isDefault =
          key in attrDefaults &&
          (value === attrDefaults[key] || isStringlyEqualScalar(value, attrDefaults[key]));
        findings.push({
          tier: isDefault ? 'atDefault' : 'undeclared',
          logicalId,
          resourceType,
          path: `${k}[${key}]`,
          actual: value,
          nested: true,
        });
      }
      continue;
    }
    // Per-type identity-keyed SUBSET arrays (Cognito UserPool.Schema): the template
    // declares a SUBSET of the elements AWS always returns. Align the declared elements
    // to live BY identity so they compare element-wise (no whole-array length-mismatch
    // FALSE positive), and emit the live-only elements as nested undeclared inventory.
    const subsetSpec = IDENTITY_KEYED_SUBSET_ARRAYS[resourceType]?.[k];
    // Per-type unordered OBJECT-array sets (R88: EC2 SecurityGroup ingress/egress) —
    // rule objects with no single identity field that AWS returns reordered. Sort BOTH
    // sides by canonical JSON before the positional diff so a reorder is not false
    // drift; a genuine rule change still differs after the sort.
    // An ORDER-significant key (a Logs Transformer processor pipeline) is never sorted, even
    // when its schema marks it insertionOrder:false — the raw order must be preserved so the
    // finding index aligns with the live model the Cloud Control revert patches (#529).
    const orderSignificant = ORDER_SIGNIFICANT_ARRAY_KEYS[resourceType]?.has(k) ?? false;
    const unorderedObjArray =
      !orderSignificant &&
      (UNORDERED_OBJECT_ARRAY_PROPS[resourceType]?.has(k) ||
        // schema-driven twin (#459): the schema marks this OBJECT array insertionOrder:false
        // (and its items carry no identity field), so a reorder is never drift.
        (schema.unorderedObjectArrayPaths?.includes(k) ?? false));
    // Per-type NESTED unordered object-array paths under this key (Bedrock Guardrail
    // ContentPolicyConfig.FiltersConfig etc.): sort the reordered set on both sides so
    // a positional diff doesn't false-flag it.
    const nestedUnordered = UNORDERED_NESTED_OBJECT_ARRAY_PATHS[resourceType];
    // A NESTED object-array path whose ORDER is semantically significant (Scheduler::Schedule
    // `Target.EcsParameters.PlacementStrategy` — strategies are evaluated in order) must NOT be
    // sorted even when the schema marks it insertionOrder:false: sortNestedObjectArrays would
    // fold an out-of-band reorder to equality, hiding real drift. Compare the FULL path
    // (`${k}.${subPath}`) since nestedSubPaths are stored RELATIVE to the top-level key k (#880).
    const orderSigPathsForType = ORDER_SIGNIFICANT_PATHS[resourceType];
    const nestedSubPaths = [
      ...new Set(
        [...(nestedUnordered ?? []), ...(schema.unorderedObjectArrayPaths ?? [])]
          .filter((p) => p.startsWith(`${k}.`) && !orderSigPathsForType?.has(p))
          .map((p) => p.slice(k.length + 1))
      ),
    ];
    let declaredVal: unknown = v;
    let liveVal: unknown = live[k];
    // For an UNORDERED_OBJECT_ARRAY, the source whose TOP-LEVEL order still matches the
    // raw template (so a sorted-index finding can be re-mapped back to the template index)
    // — nested sub-arrays already sorted (so its elements deep-equal the sorted declaredVal's)
    // but the element ORDER not yet sorted. Set only in the unorderedObjArray branch below.
    let declaredRemapSource: unknown[] | undefined;
    if (subsetSpec && Array.isArray(v) && Array.isArray(live[k])) {
      const { idField, normalizeId } = subsetSpec;
      const idOf = (e: unknown): string | undefined => {
        if (!isNestedObject(e) || typeof e[idField] !== 'string') return undefined;
        const raw = e[idField] as string;
        return normalizeId ? normalizeId(raw) : raw;
      };
      const liveById = new Map<string, unknown>();
      for (const el of live[k] as unknown[]) {
        const id = idOf(el);
        if (id !== undefined) liveById.set(id, el);
      }
      const declaredIds = new Set<string>();
      const declaredSorted: unknown[] = [];
      const liveAligned: unknown[] = [];
      // align each declared element to its live match by identity (undefined if the
      // declared attribute was removed from the pool -> a genuine declared drift). Set
      // the idField to the NORMALIZED id on both sides so the per-element compare below
      // doesn't false-flag the prefix difference itself (declared `tier` vs live
      // `custom:tier`) — the identity is already matched, the rest compares by value.
      for (const dEl of [...(v as unknown[])].sort((a, b) =>
        (idOf(a) ?? '') < (idOf(b) ?? '') ? -1 : 1
      )) {
        const id = idOf(dEl);
        if (id === undefined) continue;
        declaredIds.add(id);
        const match = liveById.get(id);
        declaredSorted.push(isNestedObject(dEl) ? { ...dEl, [idField]: id } : dEl);
        liveAligned.push(isNestedObject(match) ? { ...match, [idField]: id } : match);
      }
      // live-only elements (the always-present standard attributes, OR an out-of-band
      // custom attribute the template never declared) -> nested undeclared inventory.
      // A live-only element that deep-equals its curated default shape (Cognito's fixed,
      // immutable OIDC standard attributes) folds to `atDefault` instead — same equality-
      // gated treatment a top-level default value gets, so a never-customized pool stops
      // flooding the first run with ~20 standard-attribute entries.
      const defaultEls = IDENTITY_KEYED_DEFAULT_ELEMENTS[resourceType]?.[k];
      for (const lEl of live[k] as unknown[]) {
        const id = idOf(lEl);
        if (id !== undefined && !declaredIds.has(id)) {
          // A live-only element that is trivially-empty EXCEPT its identity field is a pure
          // AWS-materialized husk (the VPN's second tunnel) → atDefault, not undeclared.
          const isHuskExtra =
            subsetSpec.foldHuskExtras === true &&
            isNestedObject(lEl) &&
            Object.entries(lEl).every(([ek, ev]) => ek === idField || isTrivialEmpty(ev));
          // #844: an identity whose value AWS assigns (Cognito UserPoolUser `sub` — a per-user
          // UUID) folds value-independent by identity; a non-listed identity still surfaces.
          const isValueIndependentId =
            VALUE_INDEPENDENT_KEYED_ELEMENTS[resourceType]?.[k]?.has(id) ?? false;
          const atDefault =
            isHuskExtra ||
            isValueIndependentId ||
            (defaultEls && id in defaultEls && deepEqual(lEl, defaultEls[id]));
          findings.push({
            tier: atDefault ? 'atDefault' : 'undeclared',
            logicalId,
            resourceType,
            path: `${k}[${id}]`,
            actual: lEl,
            nested: true,
          });
        }
      }
      declaredVal = declaredSorted;
      liveVal = liveAligned;
    } else if (unorderedObjArray) {
      // A key in BOTH UNORDERED_OBJECT_ARRAY_PROPS and UNORDERED_NESTED_OBJECT_ARRAY_PATHS
      // (ELBv2 ListenerRule `Conditions`) needs both folds: sort each element's nested
      // unordered set FIRST (so its canonical JSON is normalized), THEN sort the object
      // array itself. Without the inner sort, the outer canonical-JSON sort sees a
      // reordered-but-equal nested set as a different element and the positional diff
      // still false-flags it.
      // The nested-sorted (but NOT yet top-level-sorted) declared source keeps the raw
      // template order, so its elements deep-equal the sorted declaredVal's elements AND
      // its index is the template index — exactly what remapSortedIndexToDeclared needs.
      const declaredNestedSorted =
        nestedSubPaths.length > 0 ? sortNestedObjectArrays(v, nestedSubPaths) : v;
      // Key the sort on the element's IDENTITY field (when the type has one) so a change to a
      // NON-identity sibling keeps the element aligned on both sides (else a mutable field that
      // sorts before the identity — Cognito ScopeDescription, Secret KmsKeyId — misaligns).
      const idField = UNORDERED_OBJECT_ARRAY_IDENTITY[resourceType]?.[k];
      declaredVal = sortUnorderedObjectArray(declaredNestedSorted, idField);
      liveVal = sortUnorderedObjectArray(
        nestedSubPaths.length > 0 ? sortNestedObjectArrays(live[k], nestedSubPaths) : live[k],
        idField
      );
      if (Array.isArray(declaredNestedSorted)) declaredRemapSource = declaredNestedSorted;
    } else if (nestedSubPaths.length > 0) {
      declaredVal = sortNestedObjectArrays(v, nestedSubPaths);
      liveVal = sortNestedObjectArrays(live[k], nestedSubPaths);
    }
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
      // a per-leaf record whose DECLARED side is (or contains) an unresolved value can't
      // be verified — already noted as `unresolved` at the property level above. Skip it
      // so the unresolvable leaf never becomes a false `declared` drift vs the symbol,
      // while its RESOLVED siblings still compare normally (the WAVE20-F1 fix).
      if (d.stateValue === UNRESOLVED || hasUnresolved(d.stateValue)) continue;
      // A NESTED declared trivially-EMPTY value (an empty sub-config `{}`, `[]`, or a
      // `false`/`""` leaf) whose live counterpart is ABSENT or equally empty is not drift:
      // many services simply OMIT an empty optional sub-object on read (Scheduler
      // `Target.SqsParameters: {}` reads back undefined). This mirrors the top-level
      // `!(k in live)` branch's rule that a declared EMPTY collection vs absent is not drift,
      // applied to a sub-path the top-level branch can't reach (the parent IS present). Gated
      // on the DECLARED side being empty, so a declared empty value against a POPULATED live
      // value still differs and surfaces as real drift.
      if (isTrivialEmpty(d.stateValue) && (d.awsValue === undefined || isTrivialEmpty(d.awsValue)))
        continue;
      // A `[{<name>,<value>}]` pair set the service reorders + default-fills (Firehose
      // processor `Parameters`, RDS OptionGroup `OptionSettings`): when every declared
      // entry is present in live with an equal value (declared subset of live), the
      // whole-array `declared` diff is a false positive — suppress it and surface the
      // live-only (server-injected) entries as nested undeclared inventory (recorded; a
      // later change still surfaces). A genuine declared entry change returns null and
      // the finding is kept as real drift.
      const nvSubsetSpec = NAME_VALUE_SUBSET_PATHS[resourceType];
      if (nvSubsetSpec?.re.test(d.path)) {
        const liveOnly = alignNameValueSubset(d.stateValue, d.awsValue, nvSubsetSpec);
        if (liveOnly) {
          for (const lo of liveOnly) {
            const loRec = lo as Record<string, unknown>;
            const loName = String(loRec[nvSubsetSpec.nameField]);
            const loValue = loRec[nvSubsetSpec.valueField];
            // #845: a Firehose Lambda processor whose declared Parameters omit `NumberOfRetries`
            // reads back the AWS default `NumberOfRetries: "3"` — a service-filled first-run
            // default, not user intent. Equality-gate the constant default so a clean stream
            // stays clean; a processor that pins a different retry count declares it (compared)
            // or, once recorded, an out-of-band change away from "3" still surfaces as undeclared.
            const isFirehoseRetriesDefault =
              resourceType === 'AWS::KinesisFirehose::DeliveryStream' &&
              loName === 'NumberOfRetries' &&
              loValue === '3';
            // #978: RDS OptionGroup materializes every unset plugin setting as a default-fill —
            // an identity-only `{Name}` husk (unset), or a value equal to the option's catalog
            // DefaultValue (gather-resolved live). Fold both atDefault, equality-gated.
            let isRdsOptionDefault = false;
            if (resourceType === 'AWS::RDS::OptionGroup') {
              if (isIdentityOnlyHusk(loRec, nvSubsetSpec.nameField)) {
                isRdsOptionDefault = true;
              } else {
                // Resolve the owning option NAME from the SORTED, index-aligned array the diff
                // index refers to (`liveVal`) — NOT the raw declared model, whose order can differ
                // from the sorted diff index (#1318). The live element at the diff index carries
                // the same `OptionName` as its declared counterpart.
                const matDefault = rdsMaterializedDefault(
                  opts.rdsOptionSettingDefaults,
                  physicalId,
                  liveVal,
                  d.path,
                  loName
                );
                isRdsOptionDefault = matDefault != null && matDefault === loValue;
              }
            }
            findings.push({
              tier: isFirehoseRetriesDefault || isRdsOptionDefault ? 'atDefault' : 'undeclared',
              logicalId,
              resourceType,
              path: `${d.path}[${loName}]`,
              actual: lo,
              nested: true,
            });
          }
          continue;
        }
      }
      // #493: composite-identity object-array subset (ElasticBeanstalk ConfigurationTemplate
      // `OptionSettings`): the template declares ~3 entries but CC returns the fully resolved
      // ~58, keyed by Namespace+OptionName with a live-only ResourceName field. Same fold as
      // the name/value subset above but with a composite key + ignored live-only fields. When
      // every declared entry is a subset of live, suppress the whole-array `declared` FP and
      // surface the service-filled extras as nested undeclared inventory.
      const ckSubsetSpec = COMPOSITE_KEY_SUBSET_PATHS[resourceType];
      if (ckSubsetSpec?.re.test(d.path)) {
        const liveOnly = alignCompositeKeySubset(d.stateValue, d.awsValue, ckSubsetSpec);
        if (liveOnly) {
          for (const lo of liveOnly) {
            const r = lo as Record<string, unknown>;
            const key = ckSubsetSpec.keyFields.map((f) => String(r[f])).join('|');
            findings.push({
              tier: ckSubsetSpec.entryTier?.(r, d.awsValue) ?? 'undeclared',
              logicalId,
              resourceType,
              path: `${d.path}[${key}]`,
              actual: lo,
              nested: true,
            });
          }
          continue;
        }
      }
      // a bare name declared for a field AWS returns as the full ARN is not drift
      // (account/region-scoped when opts are provided); likewise an AWS-managed-default
      // KMS alias vs its resolved key ARN
      if (isArnNameMatch(d.stateValue, d.awsValue, opts)) continue;
      if (isManagedKmsAliasMatch(d.stateValue, d.awsValue, opts.kmsAliasTargets)) continue;
      // a CloudWatch Logs log-group ARN whose only difference is the trailing `:*`
      // wildcard (CDK emits it; API Gateway AccessLogSetting strips it) is not drift
      if (isLogGroupArnWildcardMatch(d.stateValue, d.awsValue)) continue;
      // CFn stringly-typed scalar (Glue Parameters Map<String,String>, "5432" ports):
      // declared `true`/`5432` vs AWS `"true"`/`"5432"` is not drift.
      if (isStringlyEqualScalar(d.stateValue, d.awsValue)) continue;
      // CFn stringly-typed scalar ARRAY (R23): the drift-calculator emits the whole
      // array as one record, so the per-leaf check above can't see the elements of a
      // declared `[80, 443]` vs live `["80", "443"]`. Same typed<->string collapse,
      // element-wise; a genuine element change still differs.
      if (isStringlyEqualScalarArray(d.stateValue, d.awsValue)) continue;
      // CFn free-form `Map<String,String>` (Glue Table Parameters, DockerLabels,
      // Lambda env Variables, map Tags) emitted WHOLE at its parent path because a
      // key holds a `.` — its values are all live STRINGS while CDK declares some
      // typed (boolean `projection.enabled`, numeric counts). Fold the whole-map
      // typed<->string coercion recursively; a real key add/remove or value change
      // still differs. Not Glue-specific — any whole-emitted free-form map.
      if (isStringlyEqualDeep(d.stateValue, d.awsValue)) continue;
      // A declared object whose live form is the same value as a JSON STRING
      // (R75: SSM Document.Content) — equal after parse, key-order-insensitive.
      if (isJsonStringStructEqual(d.stateValue, d.awsValue)) continue;
      // A PEM-armored value (R125: CloudFront PublicKey EncodedKey) that
      // round-trips with only surrounding-whitespace differences — AWS appends a
      // trailing newline after the END marker — is not drift.
      if (isPemEqual(d.stateValue, d.awsValue)) continue;
      // Per-type OpenSSH public-key paths (EC2 KeyPair PublicKeyMaterial — EC2
      // rewrites the comment field to the key pair name and appends a newline):
      // the same key material (type + base64) is not drift; a genuine key change
      // still differs.
      if (
        SSH_PUBLIC_KEY_PATHS[resourceType]?.has(d.path) &&
        isSshPublicKeyEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type Redis/Valkey ACL access-string paths (ElastiCache/MemoryDB User
      // AccessString via SDK_SUPPLEMENTS — #482): the service canonicalizes the
      // string on write by inserting a `-@all` baseline term, so the same ACL modulo
      // that term is not drift; a genuine grant/pattern change still differs.
      if (
        ACCESS_STRING_PATHS[resourceType]?.has(d.path) &&
        isAccessStringEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type Java `.properties` file paths (MSK Configuration ServerProperties via
      // SDK_SUPPLEMENTS — #508): line order / blank lines / comments / trailing newline are
      // cosmetic, so the same key=value set is not drift; a genuine key/value change differs.
      if (
        PROPERTIES_FILE_PATHS[resourceType]?.has(d.path) &&
        isPropertiesFileEqual(d.stateValue, d.awsValue)
      )
        continue;
      // RDS parameter-group Parameters map: a MySQL boolean system variable declared as
      // "ON"/"OFF" reads back as "1"/"0" (RDS canonicalizes on write). Fold only when both
      // sides are boolean tokens of the SAME truthiness — a genuine flip (ON vs 0) and a
      // non-boolean value still surface. Gated to the Parameters map's leaf paths.
      if (
        BOOLEAN_PARAM_MAP_PATHS[resourceType]?.has(d.path.split('.')[0] ?? '') &&
        d.path.includes('.') &&
        isBooleanTokenEquivalent(d.stateValue, d.awsValue)
      )
        continue;
      // CloudFormation's GetTemplate returns non-ASCII string literals with every
      // non-ASCII character replaced by `?` (a documented API limitation). The DECLARED
      // side (fetched via GetTemplate) is therefore corrupted while the LIVE side is
      // intact — a guaranteed false `declared` drift on every clean deploy (observed: an
      // SSM Parameter `Value: áéíóúABC` read back as desired `?????ABC`). When the
      // live value masked the same way equals the declared value, the declared value is
      // unknowable, so surface it as a readGap (declared-but-unverifiable) instead of a
      // false drift — same informational tier used for write-only declared props.
      if (isCfnTemplateNonAsciiMask(d.stateValue, d.awsValue)) {
        findings.push({
          tier: 'readGap',
          logicalId,
          resourceType,
          path: d.path,
          note: GETTEMPLATE_MASK_NOTE,
        });
        continue;
      }
      // Per-type case-insensitive scalar paths (R75: Route53 AliasTarget.DNSName
      // — the ALB's generated DNS name is mixed-case declared, lowercase live). A `*`
      // in a table entry matches an array index: numeric path segments are normalized to
      // `*` before the lookup (e.g. `RedactedFields.0.SingleHeader.Name` -> `.*.`).
      if (
        (CASE_INSENSITIVE_PATHS[resourceType]?.has(d.path) ||
          CASE_INSENSITIVE_PATHS[resourceType]?.has(d.path.replace(/\.\d+(?=\.|$)/g, '.*'))) &&
        isCaseInsensitiveScalarEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type case-insensitive HEADER-NAME array paths (apigwv2 CORS
      // AllowHeaders/ExposeHeaders — AWS lowercases header names): the same header
      // set modulo case/order is not drift; a genuine header add/remove still differs.
      if (
        CASE_INSENSITIVE_ARRAY_PATHS[resourceType]?.has(d.path) &&
        isCaseInsensitiveEqualScalarSet(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type free-form map paths whose KEYS the Cloud Control read handler re-cases
      // (#494: DataBrew Recipe Steps[].Action.Parameters — the template + service carry
      // camelCase keys, but CC read remaps them onto the PascalCase RecipeParameters model):
      // the same map modulo key-case with equal values is not drift; a real key or value
      // change still differs. The table keys element segments with `[]`, so normalize the
      // drift path's numeric indices (`Steps.0.Action.Parameters`) to `[]` before the lookup.
      if (
        CASE_INSENSITIVE_KEY_PATHS[resourceType]?.has(d.path.replace(/\.\d+(?=\.)/g, '[]')) &&
        isCaseInsensitiveKeyMapEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type rate() schedule-expression paths (Synthetics canary Schedule.Expression
      // — AWS rewrites `rate(60 minutes)` to `rate(1 hour)`): the same total duration is
      // not drift; a genuine interval change still differs.
      if (
        RATE_EXPRESSION_PATHS[resourceType]?.has(d.path) &&
        isEquivalentRateExpression(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type epoch-seconds paths AWS rounds DOWN to the hour (AppSync ApiKey
      // Expires): the same hour is not drift; a change to a different hour still differs.
      if (EPOCH_HOUR_PATHS[resourceType]?.has(d.path) && isEpochHourEqual(d.stateValue, d.awsValue))
        continue;
      // Per-type DNS-FQDN paths whose trailing `.` is optional (Route53 HostedZone Name:
      // declared `example.com`, CC returns `example.com.`) — equal once stripped.
      if (
        TRAILING_DOT_PATHS[resourceType]?.has(d.path) &&
        isTrailingDotEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type paths whose trailing `/` is optional (ECR RepositoryCreationTemplate
      // Prefix: declared `cdkrd-hunt/`, service stores `cdkrd-hunt`) — equal once
      // stripped; a genuine prefix change still differs.
      if (
        TRAILING_SLASH_PATHS[resourceType]?.has(d.path) &&
        isTrailingSlashEqual(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type version-track paths (R130: RDS DBInstance EngineVersion) — a declared
      // partial version (`"8.0"`) that AWS resolved to the full patch version it
      // provisioned (`"8.0.45"`) is not drift; a genuine track change still differs.
      if (
        VERSION_PREFIX_PATHS[resourceType]?.has(d.path) &&
        isVersionPrefixMatch(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type `"LATEST"` sentinel paths (Fargate PlatformVersion) — a declared
      // `"LATEST"` that AWS resolved to the concrete current version is not drift; a
      // declared concrete version still compares so a genuine pin change differs.
      if (
        LATEST_SENTINEL_PATHS[resourceType]?.has(d.path) &&
        isLatestSentinelMatch(d.stateValue, d.awsValue)
      )
        continue;
      // Per-type Intelligent-Tiering paths (SSM Parameter Tier) — a declared
      // `"Intelligent-Tiering"` request that AWS resolved to the concrete tier it
      // provisioned (Standard/Advanced) is not drift; a real Standard↔Advanced change
      // still differs.
      if (
        INTELLIGENT_TIERING_PATHS[resourceType]?.has(d.path) &&
        isIntelligentTieringMatch(d.stateValue, d.awsValue)
      )
        continue;
      // Unordered scalar-array sets — same elements in the service's canonical order
      // is not drift; a genuine element change still differs after sorting. Two
      // sources: the per-type allowlist (R74: Cognito OAuth lists, and the many sets
      // AWS sorts that the schema marks insertionOrder:true) AND the schema-driven
      // `unorderedScalarPaths` (arrays AWS itself declares insertionOrder:false — no
      // table needed, FN-safe).
      if (
        (UNORDERED_ARRAY_PROPS[resourceType]?.has(d.path) ||
          // A `*` in a table entry matches an array index: numeric path segments are
          // normalized to `*` before the lookup (e.g. a CodePipeline trigger filter
          // `Triggers.0.GitConfiguration.Push.0.Branches.Includes` -> `Triggers.*.…Push.*.…`).
          UNORDERED_ARRAY_PROPS[resourceType]?.has(d.path.replace(/\.\d+(?=\.|$)/g, '.*')) ||
          schema.unorderedScalarPaths?.includes(d.path)) &&
        // An ORDER-significant scalar path (AppSync Resolver `PipelineConfig.Functions` —
        // functions execute in array order) must NOT fold a reorder to equality: exclude it so
        // an out-of-band execution-order change surfaces even though the schema lies with
        // insertionOrder:false (#880).
        !ORDER_SIGNIFICANT_PATHS[resourceType]?.has(d.path) &&
        isEqualUnorderedScalarSet(d.stateValue, d.awsValue)
      )
        continue;
      // A declared trivially-EMPTY value that the service materializes as its
      // documented default is not drift (R74: CDK Trail declares EventSelectors
      // [] and CloudTrail returns the default management selector). Equality-
      // gated on BOTH sides: the declared side must be empty (a real declared
      // value mismatch is never muted) and the live side must EQUAL the listed
      // default (any out-of-band change still surfaces).
      //
      // #929: EXCEPT when the path is meaningful-when-off. `isTrivialEmpty(false)` is
      // true, so a user who DECLARES a boolean `false` against a truthy KNOWN_DEFAULTS
      // pin (e.g. ApplicationInsights CWEMonitorEnabled, pinned `true`) would have that
      // declared `false` silently folded here whenever AWS shows the pinned `true` — an
      // out-of-band ENABLE of a monitoring/security toggle masked as "not drift". Reuse
      // the SAME MEANINGFUL_WHEN_OFF predicate the undeclared loop consults (#632): when
      // it flags this (type, path) as meaningful-when-off, skip the fold so the declared
      // divergence surfaces. Paths NOT in the table keep folding (R74 precedent intact).
      if (
        isTrivialEmpty(d.stateValue) &&
        d.path in knownDef &&
        deepEqual(d.awsValue, knownDef[d.path]) &&
        !(MEANINGFUL_WHEN_OFF[resourceType]?.[d.path]?.({ declared, live }) ?? false)
      )
        continue;
      // An UNORDERED_OBJECT_ARRAY element drift: the array was sorted on BOTH sides before
      // this per-element diff, so `d.path`'s index is the SORTED position — which does not
      // map to the live array's raw index (a Cloud Control sub-path patch would hit the wrong
      // live element) NOR to the user's template order. Re-map the reported index to the raw
      // TEMPLATE position so the path matches what the user wrote, and carry the WHOLE (raw,
      // template-order) declared array so the revert plan collapses these into one whole-array
      // replacement (revert reads wholeArrayRevert, never the index).
      // #881: registry `propertyTransform` (the LAST fold gate, after every other equality
      // check). The service transforms the declared value before storing it, so live differs
      // without any real drift (StartingPositionTimestamp ×1000, ColumnType $lowercase, ...).
      // The schema keys transforms by dotted path with a `*` array-item wildcard; the drift
      // path carries concrete numeric indices, so normalize them to `*` for the lookup. Then
      // apply transform(declared)==live (equality-gated + fail-open) exactly as CloudFormation's
      // own drift detection does. A genuinely different live value never equals the transform, so
      // this can only fold a declared FP, never hide drift.
      const transformExpr =
        schema.propertyTransforms?.[d.path] ??
        schema.propertyTransforms?.[d.path.replace(/\.\d+(?=\.|$)/g, '.*')];
      if (
        transformExpr !== undefined &&
        matchesPropertyTransform(
          transformExpr,
          d.stateValue,
          resolveParentObject(declared, d.path),
          declared,
          d.awsValue,
          d.path.split('.').at(-1) ?? d.path
        )
      )
        continue;
      // #1298: no transform is keyed AT the drift path, but a schema can key its transform at an
      // ANCESTOR path (Config::ConfigRule keys it at `Source`; the divergence surfaces at the child
      // `Source.SourceDetails`). Walk up the ancestor paths and, for any that carries a transform,
      // fold when transform(declaredRoot)==live AT the ancestor — exactly what CloudFormation folds.
      // Equality-gated + fail-open, so it can only fold a declared FP, never hide real drift.
      if (
        schema.propertyTransforms !== undefined &&
        transformExpr === undefined &&
        matchesAncestorPropertyTransform(schema.propertyTransforms, d.path, declared, live)
      )
        continue;
      // A per-element drift INSIDE a `{Key,Value}` tag list (#750): canonicalizeTagLists
      // sorted the list by `Key` on both compare sides (and stripped the live side's aws:*
      // tags), so `d.path`'s index is the SORTED+STRIPPED position that does NOT map to the
      // RAW live model Cloud Control patches — a sub-path `add /Tags/<i>/Value` patch would
      // corrupt the wrong live element or go out of range. Carry the WHOLE declared tag list
      // on wholeArrayRevert so the revert plan collapses these into ONE whole-array `/Tags`
      // replacement (tagPreservingOps then re-attaches the live aws:* managed tags), never a
      // per-element pointer against a sorted index that does not exist in the raw model.
      // Only fires for a per-element (`${k}.` sub-path) drift; a whole-array drift already
      // carries the right path. The unorderedObjArray branch above handles the type-/schema-
      // opted-in unordered object arrays; this covers the identity-sorted tag lists it misses.
      const tagListWhole =
        !unorderedObjArray &&
        Array.isArray(v) &&
        isKeyValueTagList(v) &&
        d.path.startsWith(`${k}.`);
      const unorderedExtra =
        unorderedObjArray && Array.isArray(declaredVal) && declaredRemapSource
          ? {
              // Re-map against the nested-sorted-but-raw-top-order source so a type whose
              // ELEMENTS carry their OWN unordered sub-arrays (ELBv2 ListenerRule Conditions)
              // still locates the element — a plain-`v` deep-equal would miss it because the
              // sorted declaredVal element's nested set no longer matches the raw element's.
              path: remapSortedIndexToDeclared(d.path, k, declaredVal, declaredRemapSource),
              wholeArrayRevert: { path: k, value: v },
            }
          : tagListWhole
            ? { wholeArrayRevert: { path: k, value: v } }
            : {};
      pushDeclaredFinding(findings, {
        logicalId,
        resourceType,
        path: d.path,
        desired: d.stateValue,
        actual: d.awsValue,
        ...unorderedExtra,
      });
    }
  }

  // undeclared (A1/A2/A4 + identity suppression)
  for (const [k, v] of Object.entries(live)) {
    if (k in declared) continue;
    // A WHOLLY-undeclared ELB attribute bag (a Listener that declares no ListenerAttributes
    // reads back ~20 server-default attributes) — fold PER KEY like the declared-bag branch
    // above instead of emitting the whole array: an empty value is skipped, a value equal to
    // the curated AWS default folds `atDefault`, and anything else stays `undeclared` (so a
    // genuinely-set attribute still surfaces, fail-closed).
    if (k === ELB_ATTRIBUTE_BAGS[resourceType] && Array.isArray(v)) {
      // Same per-LB-type default resolution as the declared-bag branch above: an NLB/GWLB
      // whose LoadBalancerAttributes is WHOLLY undeclared reads back its type-specific
      // defaults (cross_zone "false", deletion_protection "false"), which the shared
      // application-oriented table does not carry — merge the BY_LB_TYPE overrides so they
      // fold `atDefault` instead of surfacing as false undeclared drift.
      const lbType =
        resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer'
          ? String(live.Type ?? declared.Type ?? 'application')
          : undefined;
      const attrDefaults = {
        ...(ELB_ATTRIBUTE_DEFAULTS[resourceType] ?? {}),
        ...(lbType === undefined ? {} : (ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE[lbType] ?? {})),
      };
      for (const lEl of v) {
        if (!isKeyValueEntry(lEl)) continue;
        const key = (lEl as { Key: string }).Key;
        const value = (lEl as { Value: unknown }).Value;
        if (isTrivialEmpty(value)) continue;
        const isDefault =
          key in attrDefaults &&
          (value === attrDefaults[key] || isStringlyEqualScalar(value, attrDefaults[key]));
        findings.push({
          tier: isDefault ? 'atDefault' : 'undeclared',
          logicalId,
          resourceType,
          path: `${k}[${key}]`,
          actual: value,
          nested: true,
        });
      }
      continue;
    }
    // #1092: GuardDuty Detector Features — fold atDefault ONLY when EVERY protection is
    // ENABLED (the new-detector default). Replaces the old value-independent fold, which hid
    // an out-of-band disable of a Features-only protection (a real security downgrade that
    // never even got recorded). Name-independent, Status-gated (see guardDutyFeaturesAllEnabled).
    if (resourceType === 'AWS::GuardDuty::Detector' && k === 'Features' && Array.isArray(v)) {
      findings.push({
        tier: guardDutyFeaturesAllAtDefault(v) ? 'atDefault' : 'undeclared',
        logicalId,
        resourceType,
        path: k,
        actual: v,
      });
      continue;
    }
    // #889: an UNDECLARED default-SG list (ALB SecurityGroups / ENI GroupSet) — replaces the old
    // value-independent fold, which hid an out-of-band SG swap/append. Fold atDefault ONLY when the
    // live list is the single VPC-default SG (or the prefetch is unavailable → fail open); a 2+-element
    // APPEND or a single non-default SG SWAP falls through to the undeclared tier and surfaces.
    if (DEFAULT_SG_LIST_PATHS[resourceType] === k && !isTrivialEmpty(v)) {
      findings.push({
        tier: shouldFoldDefaultSgList(resourceType, k, v, opts.defaultSgIds)
          ? 'atDefault'
          : 'undeclared',
        logicalId,
        resourceType,
        path: k,
        actual: v,
      });
      continue;
    }
    // #1269: an UNDECLARED default-subnet list (RedshiftServerless Workgroup SubnetIds) — replaces
    // the old value-independent fold, which hid an out-of-band subnet re-placement. Fold atDefault
    // ONLY when every live subnet is a default-VPC subnet (the clean-deploy placement, or the
    // prefetch is unavailable → fail open); any subnet outside the default VPC surfaces.
    if (DEFAULT_SUBNET_LIST_PATHS[resourceType] === k && !isTrivialEmpty(v)) {
      findings.push({
        tier: shouldFoldDefaultSubnetList(resourceType, k, v, opts.defaultSubnetIds)
          ? 'atDefault'
          : 'undeclared',
        logicalId,
        resourceType,
        path: k,
        actual: v,
      });
      continue;
    }
    // #1280: AWS::EC2::TransitGateway Association/PropagationDefaultRouteTableId — at creation both
    // point at the SAME AWS-minted default route table (equal). Replaces the old value-independent
    // fold, which hid an out-of-band `modify-transit-gateway --options …DefaultRouteTableId=…` swap.
    // Fold atDefault UNLESS both ids are present AND differ (a single-field swap re-segments future
    // attachments and surfaces). A lone id (one of association/propagation disabled) folds fail-safe
    // — it has no sibling to cross-check. RESIDUAL: a both-fields swap to the same NEW table stays
    // equal and is not caught offline (needs a live DescribeTransitGatewayRouteTables).
    if (
      resourceType === 'AWS::EC2::TransitGateway' &&
      (k === 'AssociationDefaultRouteTableId' || k === 'PropagationDefaultRouteTableId') &&
      typeof v === 'string'
    ) {
      const assoc = live.AssociationDefaultRouteTableId;
      const prop = live.PropagationDefaultRouteTableId;
      const bothPresentAndDiffer =
        typeof assoc === 'string' && typeof prop === 'string' && assoc !== prop;
      findings.push({
        tier: bothPresentAndDiffer ? 'undeclared' : 'atDefault',
        logicalId,
        resourceType,
        path: k,
        actual: v,
      });
      continue;
    }
    // NOTE: no `schema.writeOnly.has(k)` guard — a top-level write-only key was
    // already stripped from `live` by writeOnlyPaths above, so it cannot reach here
    // (the old guard was dead code for top-level keys).
    // A live value EQUAL to a known AWS default is the `atDefault` tier (R86): still
    // surfaced (folded, never dropped — the report shows the complete undeclared
    // count and --show-all/--verbose lists them), but informational, not drift, and
    // not recorded by record. The equality gate means an out-of-band change away from
    // the default no longer matches here and falls through to the `undeclared` tier.
    if (
      (k in schema.defaults && matchesKnownDefault(v, schema.defaults[k])) ||
      // The authoritative top-level default source: `collectDefaultPaths` records the
      // annotated `default` for EVERY top-level property keyed by its bare name — direct,
      // `$ref`'d, AND variant-wrapped (`allOf`/`oneOf`/`anyOf`) shapes uniformly. `schema.defaults`
      // is populated only via `resolveRefNode`, which does not descend variant branches, so a
      // variant-wrapped default (e.g. BedrockAgentCore Gateway `ProtocolType` written as
      // `allOf: [ { $ref }, { default: "MCP" } ]`) is absent from `schema.defaults` yet present
      // in `defaultPaths`. Consult it here too, still equality-gated (a value CHANGED away from
      // the default falls through to `undeclared` — out-of-band detection preserved) (#1328).
      (k in schema.defaultPaths && matchesKnownDefault(v, schema.defaultPaths[k])) ||
      (k in knownDef && matchesKnownDefault(v, knownDef[k])) ||
      // A live value equal to ONE OF several stable-constant AWS defaults for this key (e.g.
      // an ApiGatewayV2 Integration's protocol-specific TimeoutInMillis, 29000 for WebSocket
      // vs 30000 for HTTP). Still equality-gated — a declared value or any value outside the
      // set falls through to `undeclared`.
      KNOWN_DEFAULT_ONE_OF[resourceType]?.[k]?.some((d) => matchesKnownDefault(v, d)) ||
      // A top-level key whose AWS default is NON-DETERMINISTIC (ECS
      // AvailabilityZoneRebalancing reads back ENABLED or DISABLED depending on the
      // service) — folded atDefault regardless of value: undeclared, so any value is
      // AWS's choice, not user intent. A trivially-empty value ([] / "" / {}) is NOT an
      // AWS-assigned default — it is just absent — so let it fall through to the shared
      // trivial-empty drop rather than surfacing a spurious atDefault (e.g. an NLB's empty
      // SecurityGroups []). But NOT when the key has a knownDef equality gate this run
      // (#894 VPCEndpoint DnsOptions, derived from VpcEndpointType above): the gate already
      // folded the AWS-default value via the `k in knownDef` branch, so a value reaching here
      // is a real out-of-band change that must surface, not be value-independent-folded.
      (VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS[resourceType]?.has(k) &&
        !isTrivialEmpty(v) &&
        !(k in knownDef)) ||
      // #705: a Classic ELB's undeclared Policies folds atDefault ONLY when it is exactly the
      // AWS default SSL negotiation policy (by PolicyName); a downgrade / added policy surfaces.
      clbDefaultSslPoliciesAtDefault(resourceType, k, v)
    ) {
      findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // A live value equal to its CONTEXT-DERIVED default — a default whose VALUE is
    // this resource's own read context (region), which a constant KNOWN_DEFAULTS
    // entry cannot express (a VPCEndpointService's SupportedRegions defaults to
    // [own region]). Equality-gated like every default fold; with no resolved
    // region it falls through to plain `undeclared` (recordable), never a wrong fold.
    const ctxKind = CONTEXT_DEFAULTS[resourceType]?.[k];
    if (ctxKind !== undefined && opts.region !== undefined) {
      const ctxDefault = ctxKind === 'region' ? opts.region : [opts.region];
      if (deepEqual(v, ctxDefault)) {
        findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
        continue;
      }
    }
    // A live value EQUAL to its CONTEXT-DERIVED ARN default — an ARN whose VALUE is built from
    // this resource's own account/region/partition (a ResourceExplorer2 View's account-root
    // Scope), which neither a constant nor the region-only CONTEXT_DEFAULTS can express.
    // Equality-gated (a view scoped elsewhere still surfaces); with no resolved account/region
    // it falls through to plain `undeclared` (recordable), never a wrong fold.
    const ctxArnTemplate = CONTEXT_ARN_DEFAULTS[resourceType]?.[k];
    if (ctxArnTemplate !== undefined && opts.region !== undefined && opts.accountId !== undefined) {
      // Canonical partition helper (#945): folds ISO partitions too. region is defined here.
      const partition = partitionForRegion(opts.region).partition;
      const region = opts.region;
      const accountId = opts.accountId;
      const substitute = (t: string): string =>
        t
          .replace('{partition}', partition)
          .replace('{region}', region)
          .replace('{accountId}', accountId);
      // A scalar template folds a single ARN string; an ARRAY template (a list-valued default
      // like Chatbot's GuardrailPolicies, #1071) folds the whole live array element-for-element.
      const matches = Array.isArray(ctxArnTemplate)
        ? deepEqual(v, ctxArnTemplate.map(substitute))
        : typeof v === 'string' && v === substitute(ctxArnTemplate);
      if (matches) {
        findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
        continue;
      }
    }
    // A live value EQUAL to its ENGINE-DERIVED default — an RDS default whose VALUE depends on
    // the resource's own live `Engine` (StorageType "aurora" for Aurora, Port 3306 for MySQL /
    // 5432 for Postgres, …), which a constant KNOWN_DEFAULTS entry cannot express. Equality-
    // gated with typed<->string coercion (a DBInstance echoes the port/storage as a string, a
    // DBCluster as a number); an engine with no single default, or a value that differs, falls
    // through to plain `undeclared` (recordable), never a wrong fold.
    const engineDefault = ENGINE_DEFAULTS[resourceType]?.[k];
    if (engineDefault !== undefined && typeof live.Engine === 'string') {
      const def = engineDefault(live.Engine);
      if (def !== undefined && (deepEqual(v, def) || isStringlyEqualScalar(v, def))) {
        findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
        continue;
      }
    }
    // #627: a provisioned DynamoDB table's top-level WarmThroughput echoes its own
    // ProvisionedThroughput (an on-demand table's {12000,4000} constant is already folded by
    // KNOWN_DEFAULTS above). Derived from the sibling ProvisionedThroughput and equality-gated,
    // so an out-of-band warm-throughput change still surfaces.
    if (
      DDB_TABLE_TYPES.has(resourceType) &&
      k === 'WarmThroughput' &&
      deepEqual(v, warmThroughputDefault(live.ProvisionedThroughput))
    ) {
      findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // A live value that is an AWS-MANAGED default resource NAME, recognized by its reserved
    // `default.` / `default:` prefix (an RDS instance's default parameter/option group) rather
    // than a constant — a CUSTOM group name never carries the prefix, so it still surfaces.
    const namePattern = DEFAULT_MANAGED_NAME_PATHS[resourceType]?.[k];
    if (namePattern !== undefined && typeof v === 'string' && namePattern.test(v)) {
      findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // #975: ElastiCache picks a member cluster `<ReplicationGroupId>-NNN` as the default
    // snapshotting cluster (which member is a per-deploy AWS choice, but the name always has
    // this deterministic shape). Fold the undeclared `SnapshottingClusterId` when it matches
    // `^<ReplicationGroupId>-\d{3}$` (the declared id, falling back to the physical id). An
    // out-of-band re-point to an UNRELATED cluster does not match the prefix and surfaces.
    if (
      resourceType === 'AWS::ElastiCache::ReplicationGroup' &&
      k === 'SnapshottingClusterId' &&
      typeof v === 'string'
    ) {
      const rgId = declared['ReplicationGroupId'] ?? physicalId;
      if (
        typeof rgId === 'string' &&
        new RegExp(`^${rgId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{3}$`).test(v)
      ) {
        findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
        continue;
      }
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
    // A CloudFormation AUTO-GENERATED physical name: when a resource declares no explicit
    // name, CFn mints `<stackName>-<logicalId>-<random>` (e.g. a Route53Resolver
    // FirewallDomainList's `Name` reads "MyStack-DL-uaPlN2cdWoMb" while its physical id is the
    // unrelated `rslvr-fdl-…`, so isGeneratedName above can't catch it). Fold it `generated`
    // so an auto-named resource is not first-run noise. Tightly gated to avoid hiding a REAL
    // undeclared value (the differentiator): the value must start with THIS stack's name AND
    // end with CFn's random suffix — a user-chosen name realistically never matches both.
    if (isCfnGeneratedName(v, resource.constructPath, physicalId, logicalId)) {
      findings.push({ tier: 'generated', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // A curated `<logicalId>-<random>` generated-name form (no `<stack>-` prefix) that the
    // isCfnGeneratedName branches miss — scoped by type+path to avoid over-folding a short
    // raw-CFn logical id's genuine undeclared names (GENERATED_LOGICALID_PREFIX_PATHS). Value-
    // dependent: an undeclared user-SET name (no logical-id prefix) still surfaces as drift.
    if (
      GENERATED_LOGICALID_PREFIX_PATHS[resourceType]?.has(k) &&
      isLogicalIdPrefixedGeneratedName(v, logicalId)
    ) {
      findings.push({ tier: 'generated', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // Cloud Control MIS-POPULATES a field by echoing a sibling: AWS::EC2::Route's
    // `VpcEndpointId` reflects the route's GATEWAY target (`igw-…`/`nat-…`/`tgw-…`) on a
    // NON-endpoint route — a value the template never set, duplicated from GatewayId. A REAL
    // VPC-endpoint route's VpcEndpointId is `vpce-…` (and declared). Drop the mis-echo so a
    // public-subnet route table is not first-run noise. (Proven live: an IGW default route
    // reads back VpcEndpointId === GatewayId === `igw-…`.)
    if (
      resourceType === 'AWS::EC2::Route' &&
      k === 'VpcEndpointId' &&
      typeof v === 'string' &&
      !v.startsWith('vpce-')
    )
      continue;
    // CC echoed an ALTERNATIVE representation of a declared value (e.g. a Subnet's
    // AvailabilityZoneId for the declared AvailabilityZone) — drop it (see CC_ALT_REPRESENTATION).
    const altSibling = CC_ALT_REPRESENTATION[resourceType]?.[k];
    if (altSibling !== undefined && altSibling in declared) continue;
    // A top-level key that is ALWAYS a service-minted generated id (value-independent):
    // the ApiGatewayV2 AutoDeploy Stage's DeploymentId, re-minted on every auto-deploy
    // and un-settable. Folded as `generated` (never drift, recorded, or reverted) so it
    // does not churn into false undeclared drift after any out-of-band API edit.
    if (GENERATED_TOPLEVEL_PATHS[resourceType]?.has(k)) {
      findings.push({ tier: 'generated', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // A TargetGroup's undeclared live `Targets` is folded `generated` (runtime membership churn,
    // never drift) ONLY when a DECLARED sibling dynamically registers into it — an ECS Service, an
    // ASG, or its own lambda TargetType (see buildSiblingTargetGroupRegistrars). With NO such
    // registrar the value is KEPT: a NON-EMPTY membership is an out-of-band `elbv2 register-targets`
    // (traffic interception) and falls through to `undeclared` below; an EMPTY `Targets: []` is
    // dropped by the shared trivial-empty rule. The old blanket generated fold hid both (#891).
    if (
      resourceType === 'AWS::ElasticLoadBalancingV2::TargetGroup' &&
      k === 'Targets' &&
      ((physicalId !== undefined && opts.siblingTargetGroupRegistrars?.has(physicalId)) ||
        opts.siblingTargetGroupRegistrars?.has(logicalId))
    ) {
      findings.push({ tier: 'generated', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // Pure structural noise (NOT a config value at default) — dropped outright: AWS
    // managed `aws:*` tags, the resource's own physical id echoed back as a property,
    // and trivially-empty {}/[]. These carry no inventory value, so they are not folded.
    if (isAllAwsTags(v)) continue;
    if (physicalId !== undefined && v === physicalId) continue;
    // #632: an OFF state (a live `false`/`""` diverging from a KNOWN_DEFAULTS pin) that is a
    // REAL divergence per the curated MEANINGFUL_WHEN_OFF predicate must NOT be swallowed by
    // the trivial-empty drop below — surface it so an out-of-band disable is detected,
    // recorded, and revertible. The atDefault gate above already `continue`d when the value
    // MATCHED the pin, so reaching here with a pin means it diverges; the predicate gates the
    // narrow set of paths whose OFF state is genuinely meaningful in this resource's config.
    const offStateIsMeaningful =
      k in knownDef &&
      !matchesKnownDefault(v, knownDef[k]) &&
      (MEANINGFUL_WHEN_OFF[resourceType]?.[k]?.({ declared, live }) ?? false);
    if (
      !offStateIsMeaningful &&
      (isTrivialEmpty(v) || isSelfEchoTrivialEmpty(v, physicalId) || isEmptyPolicyShell(v))
    )
      continue;
    // #555: a FULLY-undeclared OBJECT listed in DESCEND_UNDECLARED_OBJECT_PATHS is descended
    // leaf-by-leaf (via the SAME emitNested classification the declared-nested loop uses)
    // instead of surfacing whole — its constant sub-keys fold (atDefault / generated /
    // trivially-empty) and only the non-default residue surfaces (nested, at `k.sub`). Curated
    // per (type, path) so objects with no foldable defaults are never fragmented into noise.
    if (isNestedObject(v) && DESCEND_UNDECLARED_OBJECT_PATHS[resourceType]?.has(k)) {
      // Fully-undeclared property (no declared twin): pass declaredAbsent so an unsafe-key
      // sub-map still surfaces whole here (the declared loop won't, #1275).
      collectNestedUndeclared({}, v, k, emitNested, NESTED_ARRAY_IDENTITY[resourceType], true);
      continue;
    }
    // #629: a FULLY-undeclared identity-keyed SUBSET array (a bare Cognito UserPool's `Schema`
    // — no standardAttributes declared) reads back the whole always-present element set (all 21
    // standard attributes). The declared-side per-element fold (below) never runs because
    // nothing is declared, so the whole array surfaced. Route each live element through the SAME
    // curated-default-shape fold: an element matching its IDENTITY_KEYED_DEFAULT_ELEMENTS shape
    // folds `atDefault`, a genuinely custom (e.g. `custom:*`) attribute still surfaces. The
    // array sibling of the #555/#624 object descend.
    const subsetSpecU = IDENTITY_KEYED_SUBSET_ARRAYS[resourceType]?.[k];
    const defaultElsU = IDENTITY_KEYED_DEFAULT_ELEMENTS[resourceType]?.[k];
    // #844: a fully-undeclared UserAttributes array reaches here (nothing declared) — its
    // AWS-assigned `sub` must fold value-independent by identity too, so enter this block when
    // EITHER a curated default-shape table or a value-independent-identity table exists.
    const viIdsU = VALUE_INDEPENDENT_KEYED_ELEMENTS[resourceType]?.[k];
    if (
      subsetSpecU !== undefined &&
      (defaultElsU !== undefined || viIdsU !== undefined) &&
      Array.isArray(v)
    ) {
      const { idField, normalizeId } = subsetSpecU;
      for (const lEl of v) {
        if (!isNestedObject(lEl) || typeof lEl[idField] !== 'string') {
          findings.push({ tier: 'undeclared', logicalId, resourceType, path: k, actual: lEl });
          continue;
        }
        const raw = lEl[idField] as string;
        const id = normalizeId ? normalizeId(raw) : raw;
        const atDefault =
          (viIdsU?.has(id) ?? false) ||
          (defaultElsU !== undefined && id in defaultElsU && deepEqual(lEl, defaultElsU[id]));
        findings.push({
          tier: atDefault ? 'atDefault' : 'undeclared',
          logicalId,
          resourceType,
          path: `${k}[${id}]`,
          actual: lEl,
          nested: true,
        });
      }
      continue;
    }
    // #624 (general): a fully-undeclared OBJECT whose every leaf is a schema/known nested default
    // is entirely AWS-materialized — fold the WHOLE object atDefault. Fail-closed: a single
    // non-default leaf (or any array) leaves it surfacing whole. Runs AFTER the per-type descends
    // above, so a type curated to fragment (Athena WorkGroupConfiguration) keeps that behavior.
    // #1092: but NOT when the value is a meaningful-when-off divergence from its pin — an
    // all-false object is trivially-empty, which allLeavesAtSchemaDefault would (wrongly) treat as
    // "all at default" and fold, re-hiding the wholesale disable the trivial-drop guard above just
    // preserved (a folded atDefault is never recorded, so record would never start watching).
    if (
      !offStateIsMeaningful &&
      isNestedObject(v) &&
      Object.keys(v).length > 0 &&
      allLeavesAtSchemaDefault(v, k)
    ) {
      findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
      continue;
    }
    // #652/#643: `k` is the SHAPE-ECHO twin of a declared source shape (Firehose
    // ExtendedS3DestinationConfiguration ← declared S3DestinationConfiguration). When the
    // twin's overlapping keys ECHO the declared source (verified so a genuine out-of-band
    // change to a shared value still surfaces), descend the twin against a synthetic declared
    // side built from the source keys: the echoed overlaps are matched (not emitted) and only
    // the extended-only leaves flow through emitNested — folding the service defaults
    // (EncryptionConfiguration/CloudWatchLoggingOptions/S3BackupMode via KNOWN_DEFAULT_PATHS +
    // isTrivialEmpty) while surfacing any genuine non-default extended leaf. If the overlap does
    // NOT echo, skip the fold and let the whole twin surface below (detectable drift).
    // #712: a StepFunctions StateMachine's undeclared live `DefinitionString` (the compiled
    // JSON) MIRRORS the declared writeOnly `Definition` object form — the object was emitted
    // as a readGap and stripped from `declared` above, so its live compilation would otherwise
    // surface the WHOLE definition as undeclared drift on a clean deploy. Fold it atDefault
    // when the parsed live JSON is STRUCTURALLY EQUAL to the declared object (order-insensitive
    // via deepEqual — the pipeline's canonical deep compare). A genuine out-of-band change to
    // the state machine definition (live !== declared) fails this equality and still surfaces.
    if (sfnDefinitionObject !== undefined && k === 'DefinitionString' && typeof v === 'string') {
      let liveDefParsed: unknown;
      try {
        liveDefParsed = JSON.parse(v);
      } catch {
        liveDefParsed = undefined;
      }
      // #712 (symptom B) for the OBJECT form: `DefinitionSubstitutions` apply to BOTH
      // definition forms in CloudFormation, but the resolution above only rewrites the
      // declared `DefinitionString` STRING. For the object form the declared object still
      // carries the literal `${token}` placeholders while the live compiled `DefinitionString`
      // is already SUBSTITUTED — so serialize the declared object, resolve the tokens through
      // the SAME `applyDefinitionSubstitutions` helper #712 uses for the string form, and
      // re-parse before comparing. A genuine out-of-band definition edit still fails the
      // compares below.
      let declaredDef: unknown = sfnDefinitionObject;
      if (sfnDefinitionSubstitutions !== undefined) {
        try {
          declaredDef = JSON.parse(
            applyDefinitionSubstitutions(
              JSON.stringify(sfnDefinitionObject),
              sfnDefinitionSubstitutions
            )
          );
        } catch {
          declaredDef = sfnDefinitionObject;
        }
      }
      if (liveDefParsed !== undefined && deepEqual(liveDefParsed, declaredDef)) {
        findings.push({ tier: 'atDefault', logicalId, resourceType, path: k, actual: v });
        continue;
      }
      // #1301 (residue of #1247): GetTemplate masks every non-ASCII character in a stored
      // string literal as `?`, so a declared object `Definition` carrying non-ASCII text (a
      // Japanese `Cause` message) arrives `?`-masked while the live compiled `DefinitionString`
      // is intact — the strict compare above can never match, and letting the whole live
      // definition surface as undeclared drift on a clean deploy is a false positive. This
      // mirrors the declared `DefinitionString` branch (#1247): when the two definitions differ
      // ONLY at such masked leaves, the declared value is unknowable from GetTemplate
      // (CloudFormation itself reports it IN_SYNC), so emit the SAME readGap instead of a false
      // undeclared. A genuine out-of-band edit still fails the mask-tolerant compare and surfaces.
      if (liveDefParsed !== undefined && deepEqualModuloNonAsciiMask(declaredDef, liveDefParsed)) {
        findings.push({
          tier: 'readGap',
          logicalId,
          resourceType,
          path: 'Definition',
          note: GETTEMPLATE_MASK_NOTE,
        });
        continue;
      }
    }
    const twinSourceKey = SHAPE_ECHO_TWIN[resourceType]?.[k];
    // The source may have been writeOnly-stripped from `declared` (Firehose
    // S3DestinationConfiguration), so prefer the pre-strip snapshot; fall back to `declared`
    // for a readable source shape.
    const twinSource =
      twinSourceKey !== undefined
        ? (twinSources[twinSourceKey] ?? declared[twinSourceKey])
        : undefined;
    if (isNestedObject(v) && isNestedObject(twinSource) && twinOverlapEchoes(twinSource, v)) {
      // Map the source keys onto the twin's shape (same key names for the shared block), so
      // collectNestedUndeclared treats each echoed overlap as "declared" (present → not emitted)
      // and emits only the extended-only leaves for emitNested to classify (atDefault vs a real
      // out-of-band change).
      collectNestedUndeclared(twinSource, v, k, emitNested, NESTED_ARRAY_IDENTITY[resourceType]);
      continue;
    }
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
  // AWAY from its default no longer matches and falls back to `undeclared`. The leaf
  // classification lives in the shared `emitNested` closure (defined above, also used by
  // the fully-undeclared-object descend #555).
  for (const [k, dv] of Object.entries(declared)) {
    // Only skip a WHOLLY-unresolved property: collectNestedUndeclared descends to emit
    // LIVE-only keys, and an UNRESOLVED declared leaf is inert there (isNestedObject/
    // Array both false → no recursion, no emit). So a property that merely CONTAINS an
    // unresolved sub-value (e.g. Environment.Variables with one GetAtt) can still be
    // descended to surface a genuinely undeclared sibling sub-key — dropping the old
    // `hasUnresolved(dv)` guard, which hid that whole class (FP-safe: unresolved subtrees
    // simply aren't descended).
    if (dv === UNRESOLVED || !(k in live)) continue;
    // A JSON-string property (ConfigRule InputParameters) is compared and reported as a
    // WHOLE UNIT in the declared loop above — never descend into it for nested undeclared
    // sub-keys, which would emit a fragile dotted finding the revert can't target.
    if (JSON_STRING_PROPS[resourceType]?.has(k)) continue;
    collectNestedUndeclared(dv, live[k], k, emitNested, NESTED_ARRAY_IDENTITY[resourceType]);
  }

  // attach physicalId (for revert) + construct path (display) onto every finding
  const cp = resource.constructPath;
  const pid = resource.physicalId;
  // R111 fail-open carries a revert hazard: when the principal's sibling AWS::IAM::Policy
  // names were UNRESOLVED we did NOT filter the sibling-managed (DefaultPolicy)
  // entries out of the live Policies array (above), so a declared `Policies` diff
  // here lists own + sibling-managed entries together. The per-entry revert writer
  // deletes every prior entry the declared set drops — which would DELETE the
  // sibling-managed inline policy, removing real IAM grants. We cannot separate them,
  // so mark the Policies finding(s) so the revert plan refuses to act (a wrong-write to
  // live IAM is worse than an un-reverted FP). Applies to Role / User / Group alike.
  const unresolvedSibling =
    IAM_PRINCIPAL_POLICY_TYPES.has(resourceType) && resource.siblingPolicyNames === 'unresolved';
  return findings.map((f) => ({
    ...f,
    ...(pid !== undefined && { physicalId: pid }),
    ...(cp !== undefined && { constructPath: cp }),
    ...(unresolvedSibling && (f.path.split(/[.[]/)[0] ?? f.path) === 'Policies'
      ? { siblingPolicyNames: 'unresolved' as const }
      : {}),
  }));
}

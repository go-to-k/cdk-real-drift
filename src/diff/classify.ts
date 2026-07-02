// The heart of `check`: given a resource's resolved declared properties, its raw
// live state, and its schema info, classify every difference into a tier:
//   declared    — a declared property whose live value differs
//   undeclared  — a live property not declared, after noise subtraction (the differentiator)
//   readGap     — a declared property absent from the live read (CC-API can't read it back)
//   unresolved  — a declared property whose intrinsics couldn't be resolved (GetAtt) → skip
//
// Pure: no AWS calls. liveRaw is the CC API GetResource model (un-stripped).

import {
  isArnNameMatch,
  isLogGroupArnWildcardMatch,
  isManagedKmsAliasMatch,
} from '../normalize/arn-identity.js';
import { stripCcApiAwsManagedFields } from '../normalize/cc-api-strip.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import {
  CASE_INSENSITIVE_ARRAY_PATHS,
  CASE_INSENSITIVE_PATHS,
  isAllAwsTags,
  identityField,
  isCaseInsensitiveEqualScalarSet,
  isCaseInsensitiveScalarEqual,
  isCfnTemplateNonAsciiMask,
  isEqualUnorderedScalarSet,
  isEquivalentRateExpression,
  isJsonStringStructEqual,
  JSON_STRING_PROPS,
  isPemEqual,
  isSshPublicKeyEqual,
  SSH_PUBLIC_KEY_PATHS,
  isStringlyEqualScalar,
  isStringlyEqualScalarArray,
  isStringlyEqualDeep,
  isGeneratedName,
  isPhysicalIdSegment,
  isTrailingDotEqual,
  isTrivialEmpty,
  isVersionPrefixMatch,
  isLatestSentinelMatch,
  isIntelligentTieringMatch,
  INTELLIGENT_TIERING_PATHS,
  LATEST_SENTINEL_PATHS,
  TRAILING_DOT_PATHS,
  GENERATED_PATHS,
  GENERATED_TOPLEVEL_PATHS,
  EPOCH_HOUR_PATHS,
  IDENTITY_KEYED_DEFAULT_ELEMENTS,
  isEpochHourEqual,
  KNOWN_DEFAULT_PATHS,
  KNOWN_DEFAULTS,
  READGAP_COLLECTION_PATHS,
  ELB_ATTRIBUTE_DEFAULTS,
  PARAMETER_NAME_SUBSET_PATHS,
  alignParameterNameSubset,
  RATE_EXPRESSION_PATHS,
  resolveGeneratedDefault,
  sortNestedObjectArrays,
  sortUnorderedObjectArray,
  stripAsymmetricIdentityFields,
  stripAwsTagsDeep,
  UNORDERED_ARRAY_PROPS,
  UNORDERED_NESTED_OBJECT_ARRAY_PATHS,
  UNORDERED_OBJECT_ARRAY_PROPS,
  VERSION_PREFIX_PATHS,
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

// Remove from `arr` the first element each sibling rule is a SUBSET of (every sibling key
// deep-equals the live element's — the live element carries AWS-injected extras the sibling
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
        Object.entries(sub).every(([k, v]) => deepEqual((el as Record<string, unknown>)[k], v))
    );
    if (i >= 0) arr.splice(i, 1);
  }
  if (arr.length === 0) delete live[prop]; // empty array == absent; don't introduce a []-vs-absent FP
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
};

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

// A CloudFormation AUTO-GENERATED physical name. When a resource declares no explicit name,
// CFn mints `<stackName>-<logicalId>-<random>` (the stack name is the FIRST segment of the
// CDK construct path). DELIBERATELY strict — it must start with this stack's name AND end
// with CFn's ~12+ char alphanumeric random suffix — so a user-chosen name is not folded away
// (that would hide a real undeclared value, defeating the differentiator). Pure.
const CFN_RANDOM_SUFFIX = /-[0-9A-Za-z]{12,}$/;
function isCfnGeneratedName(
  value: unknown,
  constructPath: string | undefined,
  physicalId: string | undefined
): boolean {
  // The bare physical-id echo (value === physicalId) is a STRUCTURAL drop handled separately
  // — never fold it into a `generated` finding here, or a resource whose physical id IS its
  // CFn-generated name gains a phantom finding.
  if (typeof value !== 'string' || !constructPath || value === physicalId) return false;
  const stackName = constructPath.split('/')[0];
  return !!stackName && value.startsWith(`${stackName}-`) && CFN_RANDOM_SUFFIX.test(value);
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
  if (!isNestedObject(live) || !isNestedObject(def)) return false;
  return Object.entries(live).every(([k, v]) => k in def && deepEqual(v, def[k]));
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
  nestedArrayIdentity?: Record<string, string>
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
  for (const [k, val] of Object.entries(liveVal)) {
    const childPath = `${path}.${k}`;
    if (k in declaredVal)
      collectNestedUndeclared(declaredVal[k], val, childPath, emit, nestedArrayIdentity);
    else emit(childPath, val);
  }
}

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
function sortUnorderedSetProps(model: Record<string, unknown>, resourceType: string): void {
  for (const k of UNORDERED_OBJECT_ARRAY_PROPS[resourceType] ?? [])
    if (Array.isArray(model[k])) model[k] = sortUnorderedObjectArray(model[k]);
  for (const k of UNORDERED_ARRAY_PROPS[resourceType] ?? []) {
    const v = model[k];
    if (
      Array.isArray(v) &&
      v.every((e) => typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean')
    )
      model[k] = [...v].sort((a, b) =>
        `${typeof a}:${String(a)}` < `${typeof b}:${String(b)}` ? -1 : 1
      );
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
  if (opts.resourceType) sortUnorderedSetProps(live, opts.resourceType);
  return live;
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
    // Rules declared by SIBLING standalone AWS::EC2::SecurityGroupIngress/::SecurityGroupEgress
    // resources, keyed by the target SG's resolved GroupId (== the SG's physical id). Subtracted
    // from an AWS::EC2::SecurityGroup's reflected live rule arrays so they are not double-counted.
    siblingSgRules?: Record<string, { ingress: unknown[]; egress: unknown[] }>;
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
  const live = normalizeLiveModel(liveForCompare, schema, {
    oaiCanonicalIds: oaiMap,
    resourceType,
  });
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
  // writeOnly cannot be read back: strip it from the DECLARED side too so it is never
  // compared (the LIVE side was already stripped by normalizeLiveModel above).
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
      // Wholly unresolved, OR partially unresolved but not in live to compare against:
      // nothing more to do. Otherwise fall through to compare the RESOLVED sub-values —
      // a sibling sub-value's drift (e.g. a changed Environment.Variables entry next to a
      // GetAtt-valued one) must not be hidden just because a SIBLING leaf is unresolved.
      // The compare below skips any per-leaf record whose declared side is unresolved.
      if (v === UNRESOLVED || !(k in live)) continue;
    } else if (!(k in live)) {
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
      if (isNonEmptyCollection && !READGAP_COLLECTION_PATHS[resourceType]?.has(k)) {
        findings.push({
          tier: 'declared',
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
        findings.push({
          tier: 'declared',
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
        findings.push({
          tier: 'declared',
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
      const attrDefaults = ELB_ATTRIBUTE_DEFAULTS[resourceType] ?? {};
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
    const unorderedObjArray = UNORDERED_OBJECT_ARRAY_PROPS[resourceType]?.has(k);
    // Per-type NESTED unordered object-array paths under this key (Bedrock Guardrail
    // ContentPolicyConfig.FiltersConfig etc.): sort the reordered set on both sides so
    // a positional diff doesn't false-flag it.
    const nestedUnordered = UNORDERED_NESTED_OBJECT_ARRAY_PATHS[resourceType];
    const nestedSubPaths = nestedUnordered
      ? [...nestedUnordered].filter((p) => p.startsWith(`${k}.`)).map((p) => p.slice(k.length + 1))
      : [];
    let declaredVal: unknown = v;
    let liveVal: unknown = live[k];
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
          const atDefault = defaultEls && id in defaultEls && deepEqual(lEl, defaultEls[id]);
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
      declaredVal = sortUnorderedObjectArray(
        nestedSubPaths.length > 0 ? sortNestedObjectArrays(v, nestedSubPaths) : v
      );
      liveVal = sortUnorderedObjectArray(
        nestedSubPaths.length > 0 ? sortNestedObjectArrays(live[k], nestedSubPaths) : live[k]
      );
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
      // A `[{ParameterName,ParameterValue}]` set the service reorders + default-fills
      // (Firehose processor `Parameters`): when every declared param is present in live
      // with an equal value (declared subset of live), the whole-array `declared` diff is
      // a false positive — suppress it and surface the live-only (server-injected) params
      // as nested undeclared inventory (recorded; a later change still surfaces). A genuine
      // declared param change returns null and the finding is kept as real drift.
      const paramSubsetRe = PARAMETER_NAME_SUBSET_PATHS[resourceType];
      if (paramSubsetRe?.test(d.path)) {
        const liveOnly = alignParameterNameSubset(d.stateValue, d.awsValue);
        if (liveOnly) {
          for (const lo of liveOnly) {
            findings.push({
              tier: 'undeclared',
              logicalId,
              resourceType,
              path: `${d.path}[${String((lo as Record<string, unknown>).ParameterName)}]`,
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
          note: 'declared value unverifiable — CloudFormation GetTemplate masks non-ASCII characters as "?"',
        });
        continue;
      }
      // Per-type case-insensitive scalar paths (R75: Route53 AliasTarget.DNSName
      // — the ALB's generated DNS name is mixed-case declared, lowercase live).
      if (
        CASE_INSENSITIVE_PATHS[resourceType]?.has(d.path) &&
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
          schema.unorderedScalarPaths?.includes(d.path)) &&
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
      (k in schema.defaults && matchesKnownDefault(v, schema.defaults[k])) ||
      (k in knownDef && matchesKnownDefault(v, knownDef[k]))
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
    // A CloudFormation AUTO-GENERATED physical name: when a resource declares no explicit
    // name, CFn mints `<stackName>-<logicalId>-<random>` (e.g. a Route53Resolver
    // FirewallDomainList's `Name` reads "MyStack-DL-uaPlN2cdWoMb" while its physical id is the
    // unrelated `rslvr-fdl-…`, so isGeneratedName above can't catch it). Fold it `generated`
    // so an auto-named resource is not first-run noise. Tightly gated to avoid hiding a REAL
    // undeclared value (the differentiator): the value must start with THIS stack's name AND
    // end with CFn's random suffix — a user-chosen name realistically never matches both.
    if (isCfnGeneratedName(v, resource.constructPath, physicalId)) {
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
  // R140: nested paths that are always an AWS-assigned generated id (value-independent),
  // folded as `generated` like the top-level isGeneratedName/GENERATED_DEFAULTS cases.
  const generatedPaths = GENERATED_PATHS[resourceType] ?? [];
  // Schema-detected FREE-FORM MAP properties (Lambda Environment.Variables, Glue
  // Parameters): a live-only sub-key directly under one is user-authored data, not an
  // AWS-materialized nested default — so flag it `freeFormKey` to surface it in the report
  // (the generic nested fold would hide a console-added env var as first-run noise).
  const freeFormMapPaths = schema.freeFormMapPaths ?? [];
  const underFreeFormMap = (schemaPath: string): boolean =>
    freeFormMapPaths.some((ff) => schemaPath.startsWith(`${ff}.`));
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
    collectNestedUndeclared(
      dv,
      live[k],
      k,
      (path, value) => {
        if (isAllAwsTags(value) || isTrivialEmpty(value)) return;
        const schemaPath = path.replace(/\[[^\]]*\]/g, '.*');
        // Same subset-tolerant default match as the top-level atDefault compare: an
        // OBJECT-valued nested default (CloudFront GeoRestriction, Scheduler RetryPolicy,
        // Cognito SignInPolicy, …) that AWS returns with a sub-key omitted still folds,
        // while a sub-key changed away from the default — or an extra key — surfaces.
        // Falls back to deepEqual for scalars/arrays, so nothing else changes.
        const atDefault =
          (schemaPath in schema.defaultPaths &&
            matchesKnownDefault(value, schema.defaultPaths[schemaPath])) ||
          (schemaPath in knownDefPaths && matchesKnownDefault(value, knownDefPaths[schemaPath]));
        const tier = atDefault
          ? 'atDefault'
          : // R142: a GENERATED_PATHS value folds as `generated` ONLY when it echoes a
            // physical-id segment (the AWS default) — a custom value the user set surfaces.
            generatedPaths.includes(schemaPath) && isPhysicalIdSegment(value, physicalId)
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
      },
      NESTED_ARRAY_IDENTITY[resourceType]
    );
  }

  // attach physicalId (for revert) + construct path (display) onto every finding
  const cp = resource.constructPath;
  const pid = resource.physicalId;
  // R111 fail-open carries a revert hazard: when the role's sibling AWS::IAM::Policy
  // names were UNRESOLVED we did NOT filter the sibling-managed (DefaultPolicy)
  // entries out of the live Policies array (above), so a declared `Policies` diff
  // here lists own + sibling-managed entries together. The per-entry revert writer
  // (writeIamRoleInlinePolicies) deletes every prior entry the declared set drops —
  // which would DELETE the sibling-managed inline policy, removing real IAM grants.
  // We cannot separate them, so mark the Policies finding(s) so the revert plan
  // refuses to act (a wrong-write to live IAM is worse than an un-reverted FP).
  const unresolvedSibling =
    resourceType === 'AWS::IAM::Role' && resource.siblingPolicyNames === 'unresolved';
  return findings.map((f) => ({
    ...f,
    ...(pid !== undefined && { physicalId: pid }),
    ...(cp !== undefined && { constructPath: cp }),
    ...(unresolvedSibling && (f.path.split(/[.[]/)[0] ?? f.path) === 'Policies'
      ? { siblingPolicyNames: 'unresolved' as const }
      : {}),
  }));
}

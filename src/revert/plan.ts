// Build a revert plan from drift findings (pure — no AWS). Revert writes the
// DESIRED value back to AWS:
//   declared drift   -> the deployed-template value (finding.desired)
//   undeclared drift -> the baseline value if recorded before (restore), else
//                       REMOVE (the value appeared since a snapshot-complete record)
//   removed-undeclared (baseline value gone) -> re-add the baseline value
// UNRECORDED values (R62: no baseline entry, resource never snapshot-complete)
// are not drift and have no revert target — notRevertable unless
// --remove-unrecorded explicitly turns them into REMOVE ops.
// Not revertable: readGap / unresolved / skipped, and (v1) the SDK-override
// CC-gap types (revert for those is a follow-up).
import type { BaselineFile } from '../baseline/baseline-file.js';
import { withinStackPath } from '../construct-path.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import {
  awsManagedTags,
  JSON_STRING_PROPS,
  KNOWN_DEFAULT_PATHS,
  KNOWN_DEFAULTS,
} from '../normalize/noise.js';
import { SDK_OVERRIDES } from '../read/overrides.js';
import type { Finding, SchemaInfo } from '../types.js';
import { SDK_NESTED_WRITERS, SDK_PROP_WRITERS, SDK_WRITERS } from './writers.js';

// Per type, the writeOnly props that an SDK_SUPPLEMENTS reader makes COMPARABLE
// (detection works) but Cloud Control still cannot revert via a nested sub-path patch
// (CC can't navigate into a writeOnly prop it can't read) AND no type-specific SDK
// writer covers yet. Findings under these paths are reported not-revertable instead of
// emitting a CC patch that always fails. (ECS `ServiceConnectConfiguration` GRADUATED
// out of this table — it now reverts via the `SDK_NESTED_WRITERS` UpdateService writer.
// ECS `VolumeConfigurations` will populate it once that prop is projected.)
// (AWS::MSK::Configuration `ServerProperties` GRADUATED out of this table — it now reverts
// via the `SDK_PROP_WRITERS` kafka:UpdateConfiguration writer, which creates the next
// revision carrying the desired properties.)
const WRITEONLY_NESTED_NO_CC_REVERT: Record<string, readonly string[]> = {};

// Per type, SYNTHETIC top-level fields an SDK_SUPPLEMENTS reader COMPUTES (not real AWS
// properties) as an integrity signal for a value that is otherwise unreadable — currently
// AWS::ElasticLoadBalancingV2::TrustStore `CaCertificatesBundleSha256`, a digest of the live
// CA bundle content (#505). They surface as undeclared drift that `record` snapshots (so a
// later content swap re-surfaces), but they have no write target, so a revert on one is
// reported not-revertable rather than emitting a `remove` that always fails.
const SYNTHETIC_READ_SIGNAL_PATHS: Record<string, readonly string[]> = {
  'AWS::ElasticLoadBalancingV2::TrustStore': ['CaCertificatesBundleSha256'],
};

// SDK-override types that are nonetheless Cloud Control FULLY_MUTABLE — their override
// exists only to work around a READ quirk, NOT because CC cannot UPDATE them, so a CC
// UpdateResource revert is valid and they are EXEMPT from the "read-override => not
// revertable" rule below. AWS::Scheduler::Schedule is the case: its CC read handler
// only looks in the DEFAULT schedule group (the override reads via Scheduler
// GetSchedule with the declared GroupName), but CC can update it fine. Verified live —
// a schedule State revert via CC succeeds for the common default-group case. (A
// non-default-group schedule would fail at apply with a clear AWS error, not silently.)
// AWS::Cognito::IdentityPool: the override exists only to ENRICH the CC read with the
// writeOnly CognitoEvents (CC reads/updates every base property — AllowClassicFlow,
// providers, … — fine). So base-property reverts route through CC UpdateResource as
// normal; only the CognitoEvents path takes its dedicated SDK_PROP_WRITER.
const CC_REVERTABLE_DESPITE_READ_OVERRIDE = new Set<string>([
  'AWS::Scheduler::Schedule',
  'AWS::Cognito::IdentityPool',
]);

// Properties whose undeclared "appeared since record" revert must EXPLICITLY write the
// AWS default value (an `add` of KNOWN_DEFAULTS[type][path]) instead of an RFC6902
// `remove`. The default revert for such a value is `remove`, which for most types makes
// the provider clear the property (IAM Role Description -> "", Tags -> untagged) or
// delete a sub-config that AWS then re-defaults (S3 DeleteBucketOwnershipControls,
// VersioningConfiguration -> Suspended). But a handful of providers leave the property
// UNCHANGED when it is simply absent from the desired model — so `remove` is a SILENT
// no-op (Cloud Control reports SUCCESS yet the live value persists). IAM's UpdateRole is
// the proven case: it ignores a missing MaxSessionDuration, so reverting an out-of-band
// 7200 back toward the 3600 default never converged. For these, write the known default
// explicitly. Keyed `${resourceType}\0${propertyPath}`; the value comes from the same
// KNOWN_DEFAULTS table (single source of truth), so an entry here without a matching
// KNOWN_DEFAULTS default falls through to `remove`. Curated rather than "every
// KNOWN_DEFAULTS entry" on purpose: KNOWN_DEFAULTS holds read-side COMPARE shapes (some
// projected/normalized, not valid CC write inputs), and most entries already converge
// via `remove` — broadening blindly would regress them and risk writing an unwritable
// shape. Add a property here only once a `remove` no-op is observed for it.
//   - AWS::Lambda::Alias Description: UpdateAlias ignores an OMITTED description (keeps
//     the existing value), so a bare `remove` is a silent no-op — Cloud Control reports
//     SUCCESS yet the live description persists. Writing the empty-string default (an
//     `add /Description ""`) clears it. Both behaviours proven live.
const REVERT_SET_DEFAULT_PATHS = new Set<string>([
  'AWS::IAM::Role\0MaxSessionDuration',
  'AWS::Lambda::Alias\0Description',
  // Cognito UpdateIdentityPool ignores an omitted AllowClassicFlow (live-observed: a
  // `remove` revert of an out-of-band `true` is a silent no-op), so write the `false`
  // default explicitly.
  'AWS::Cognito::IdentityPool\0AllowClassicFlow',
  // Transfer UpdateServer ignores an omitted SecurityPolicyName (live-observed: a
  // `remove` revert of an out-of-band non-default policy reports SUCCESS yet the live
  // value persists), so write the default policy (TransferSecurityPolicy-2018-11) back
  // explicitly. The value comes from KNOWN_DEFAULTS.
  'AWS::Transfer::Server\0SecurityPolicyName',
  // App Runner UpdateService IGNORES an omitted top-level config object (live-observed:
  // a `remove` revert of an out-of-band HealthCheckConfiguration reports SUCCESS yet the
  // live value persists — mutated Interval 5->10 survived the revert). Write the whole
  // KNOWN_DEFAULTS default object back explicitly so revert converges. NetworkConfiguration
  // is the same provider behavior (top-level object AWS materializes; UpdateService keeps
  // the existing value on omit) and writing its default public-IPV4 config back is safe /
  // idempotent whether or not the omit no-ops.
  'AWS::AppRunner::Service\0HealthCheckConfiguration',
  'AWS::AppRunner::Service\0NetworkConfiguration',
  // Amazon Location UpdateTracker IGNORES an omitted PositionFiltering (live-observed on
  // location-rich 2026-07-07: a `remove` revert of an out-of-band AccuracyBased reported
  // SUCCESS yet the live value stayed AccuracyBased — "1 drift remain"). Write the
  // "TimeBased" default (from KNOWN_DEFAULTS) back explicitly so revert converges.
  'AWS::Location::Tracker\0PositionFiltering',
  // Amazon Location UpdatePlaceIndex likewise IGNORES an omitted DataSourceConfiguration
  // (live-observed 2026-07-07: a `remove` revert of an out-of-band IntendedUse=Storage
  // reported SUCCESS yet the live value stayed Storage — "1 drift remain"). Write the whole
  // {IntendedUse:"SingleUse"} default object back explicitly (2nd object-valued entry after
  // AppRunner) so revert converges.
  'AWS::Location::PlaceIndex\0DataSourceConfiguration',
  // EventBridge UpdateApiDestination IGNORES an omitted InvocationRateLimitPerSecond
  // (live-observed on events-apidest-rich 2026-07-08: a `remove` revert of an out-of-band
  // 50 reported SUCCESS yet the live value stayed 50 — "1 drift remain"). Write the 300
  // default (from KNOWN_DEFAULTS) back explicitly so revert converges.
  'AWS::Events::ApiDestination\0InvocationRateLimitPerSecond',
  // Cognito UpdateUserPool is a FULL-PUT provider: it IGNORES an omitted property and keeps
  // the existing live value, so a bare `remove` revert of an out-of-band change is a silent
  // no-op. Live-proven for DeletionProtection (#630, reproduced twice: a bare pool set to
  // ACTIVE out of band, then `revert --remove-unrecorded` planned a `remove`, reported
  // CLEAN, yet the live pool stayed ACTIVE). MfaConfiguration and UserPoolTier are the same
  // provider family (same UpdateUserPool omit-ignored behavior), so write their KNOWN_DEFAULTS
  // defaults (INACTIVE / OFF / ESSENTIALS) back explicitly — idempotent and safe.
  'AWS::Cognito::UserPool\0DeletionProtection',
  'AWS::Cognito::UserPool\0MfaConfiguration',
  'AWS::Cognito::UserPool\0UserPoolTier',
  // Policies is the same UpdateUserPool omit-ignored behavior (#702, live-proven: mutating
  // PasswordPolicy.MinimumLength out of band, then `revert --remove-unrecorded` planned a
  // `remove`, reported reverted, yet the live pool stayed MinimumLength=10). Its whole-object
  // KNOWN_DEFAULTS default (min length 8, all four char classes, 7-day temp lifetime, PASSWORD
  // first factor) is written back explicitly so revert converges.
  // BLAST RADIUS: UpdateUserPool ignores EVERY omitted field, so ANY future UserPool
  // KNOWN_DEFAULTS addition needs a matching entry here. VerificationMessageTemplate /
  // AccountRecoverySetting are the next two (their folds land with #701 — add them once the
  // KNOWN_DEFAULTS defaults exist so the set-default write resolves a value).
  'AWS::Cognito::UserPool\0Policies',
  // SNS SetSubscriptionAttributes HARD-FAILS a `remove` of FilterPolicyScope (#630,
  // live-proven: setting it to MessageBody out of band, then reverting via `remove` fails with
  // InvalidRequest "FilterPolicyScope: Invalid value [null]. Please use either MessageBody or
  // MessageAttributes"). SNS refuses to clear the attribute, so revert can only converge by
  // SETTING the "MessageAttributes" default (from KNOWN_DEFAULTS) explicitly.
  'AWS::SNS::Subscription\0FilterPolicyScope',
  // InternetMonitor UpdateMonitor IGNORES an omitted Status (live-proven follow-up to the
  // #626 fold: a monitor paused out of band to INACTIVE, then `revert --remove-unrecorded`
  // planned a `remove`, reported CLEAN, yet live `get-monitor` stayed INACTIVE). Write the
  // "ACTIVE" default (from KNOWN_DEFAULTS) back explicitly so revert converges.
  'AWS::InternetMonitor::Monitor\0Status',
  // RolesAnywhere UpdateProfile IGNORES an omitted DurationSeconds (live-proven follow-up to
  // the #619 fold: a profile's session duration changed out of band to 7200, then
  // `revert --remove-unrecorded` planned a `remove`, reported reverted, yet live `get-profile`
  // stayed 7200). Write the 3600 default (from KNOWN_DEFAULTS) back explicitly so revert
  // converges. (Contrast AWS::Bedrock::Agent IdleSessionTTLInSeconds, verified same session to
  // CONVERGE via a plain `remove` — UpdateAgent re-materializes the 600 default on omit — so it
  // needs NO entry here.)
  'AWS::RolesAnywhere::Profile\0DurationSeconds',
  // RolesAnywhere ignores an omitted AttributeMappings on update the same way (live-proven:
  // an out-of-band put-attribute-mapping changed x509Subject *->CN, then `revert` planned a
  // `remove`, which the provider reported reverted yet left the live mapping CN). Write the
  // whole default attribute-mapping array (from KNOWN_DEFAULTS) back explicitly so revert
  // converges — the whole-array-valued twin of DurationSeconds above.
  'AWS::RolesAnywhere::Profile\0AttributeMappings',
  // EC2 ModifySubnetAttribute IGNORES an omitted EnableDns64 (live-proven on a dual-stack
  // VPC 2026-07-08: EnableDns64 flipped `true` out of band, then `revert` planned a `remove`,
  // Cloud Control reported the update applied, yet `describe-subnets` stayed `True` — the
  // revert looped forever, #651). The subnet's `EnableDns64` default is the plain constant
  // `false`, but it folds `atDefault` via the CFn SCHEMA default (not KNOWN_DEFAULTS), so the
  // set-default value comes from REVERT_SET_DEFAULT_VALUES below rather than KNOWN_DEFAULTS.
  // Sibling undeclared subnet attributes hit by the same EC2 ModifySubnetAttribute
  // omit-is-ignored no-op the #651 issue flagged — each folds `atDefault` from
  // KNOWN_DEFAULTS (AWS::EC2::Subnet), so writing that default explicitly converges
  // where a `remove` silently no-ops.
  //   - PrivateDnsNameOptionsOnLaunch: LIVE-VERIFIED 2026-07-08 on a dual-stack VPC —
  //     enabled a resource-name DNS record out of band, `revert`'s `remove` left it
  //     unchanged ("1 drift(s) remain"), the set-default (whole default object)
  //     converges (CLEAN after revert). This is the object-valued twin of EnableDns64.
  //   - AssignIpv6AddressOnCreation: CDK DECLARES it on every dual-stack subnet, so it is
  //     not reachable as undeclared drift through CDK (a declared revert already
  //     converges); this entry defensively covers the raw-CFn case where the attribute is
  //     left undeclared and flipped out of band — same provider omit-no-op, same fix.
  //   - Ipv6Native is create-only (not settable by ModifySubnetAttribute), so it cannot
  //     drift out of band and needs no revert entry — it folds fine as `atDefault`.
  'AWS::EC2::Subnet\0AssignIpv6AddressOnCreation',
  'AWS::EC2::Subnet\0PrivateDnsNameOptionsOnLaunch',
  'AWS::EC2::Subnet\0EnableDns64',
]);

// Set-default values for REVERT_SET_DEFAULT_PATHS entries whose default is a plain constant
// that folds `atDefault` via the CFn SCHEMA default rather than KNOWN_DEFAULTS (so it is
// absent from that table). Consulted as a FALLBACK when KNOWN_DEFAULTS carries no value for
// the path — KNOWN_DEFAULTS stays the primary source. Keyed `${resourceType}\0${path}`.
const REVERT_SET_DEFAULT_VALUES: Record<string, unknown> = {
  'AWS::EC2::Subnet\0EnableDns64': false,
};

/**
 * A nested undeclared value (a live sub-key inside a declared object, R96/R98) — a dotted
 * path (`Conf.Destination`) or an identity-keyed array element (`Prop[<id>].sub`). Pure +
 * exported. Detected by PATH SHAPE, not just `Finding.nested`: a baseline value removed
 * since record is reconstructed without the flag but keeps its nested path. A top-level
 * undeclared path is a single key (no '.'/'[').
 */
export function isNestedUndeclared(f: Finding): boolean {
  return (
    f.tier === 'undeclared' && (Boolean(f.nested) || f.path.includes('.') || f.path.includes('['))
  );
}

/**
 * Of the nested undeclared values, the ones revert genuinely CANNOT target: an ARRAY
 * ELEMENT path (it contains a `[<id>]`/`[<index>]` bracket). `toPointer` builds an RFC6902
 * pointer by splitting on '.', so a bracket survives as a literal segment (`/Prop[<id>]/sub`)
 * that addresses a key named `Prop[<id>]`, not the array element — the patch is malformed
 * (the same reason R78 abandoned index-based array patches). A PURE-DOTTED nested path
 * (`Environment.Variables.<key>` free-form map keys, or a sub-field of a declared object)
 * IS a valid pointer that Cloud Control applies read-modify-write — proven live removing an
 * out-of-band Lambda env var — so it stays revertable. That INCLUDES a MAP-shaped tag key
 * (`Tags.<key>`, e.g. AWS::SSM::Parameter): a single-key `remove /Tags/<key>` is proven live
 * to succeed AND leave the live `aws:*` managed tags untouched (Cloud Control's read-modify-
 * write keeps every other key, so the provider never untags the managed ones — no rewrite
 * needed). A LIST-shaped tag element (`Tags[<id>].sub`) stays barred by the bracket rule.
 * Pure + exported so the action picker offers `revert` exactly where revert can run.
 */
export function isUnrevertableNested(f: Finding): boolean {
  return isNestedUndeclared(f) && f.path.includes('[');
}

// An out-of-band ManagedPolicy attachment member (a live-only `Roles[x]`/`Users[x]`/
// `Groups[x]` — the union, surfaced as nested undeclared). Unlike a generic nested
// undeclared value, this one HAS a precise, flat SDK op to undo it (DetachX-Policy by
// member), so writeIamManagedPolicy can revert it exactly — it is NOT subject to the
// "nested undeclared is record-only" bar (which exists because a flat patch can't
// safely target a deep sub-field). Removal still requires --remove-unrecorded like any
// unrecorded undeclared value (the unrecorded guard below), so it never auto-detaches.
export function isManagedPolicyAttachmentMember(f: Finding): boolean {
  return (
    f.tier === 'undeclared' &&
    f.resourceType === 'AWS::IAM::ManagedPolicy' &&
    /^(Roles|Users|Groups)\[.+\]$/.test(f.path)
  );
}

// A nested finding path a type-specific SDK writer can revert PRECISELY (SDK_NESTED_WRITERS) —
// e.g. an ApiGateway Method's Integration.IntegrationResponses[<sc>].SelectionPattern. Like
// isManagedPolicyAttachmentMember, it lifts the path off the "nested undeclared is
// record-only" bar (which exists only because a flat RFC6902 patch can't target a deep
// sub-field) and routes it to the writer instead of Cloud Control.
export function isNestedSdkWritable(f: Finding): boolean {
  return SDK_NESTED_WRITERS[f.resourceType]?.match(f.path) ?? false;
}

export interface PatchOp {
  op: 'add' | 'remove';
  path: string; // RFC6902 JSON pointer into the resource Properties model
  value?: unknown;
  // the finding's CURRENT live value, for property-scoped SDK writers that revert
  // per entry (e.g. IAM Role inline Policies). Never serialized to Cloud Control
  // (toPatchDocument picks op/path/value only).
  prior?: unknown;
  // R78: the Key of a changed attribute inside an ELB attribute bag. Set only for
  // attribute-bag findings; the SDK writer sends `{Key, Value: value}` via
  // ModifyLoadBalancerAttributes. Never serialized to Cloud Control.
  attributeKey?: string;
  human: string; // one-line description for the plan display
}

export interface RevertItem {
  logicalId: string;
  displayId: string; // construct path or logical id
  resourceType: string;
  physicalId: string;
  // cc = Cloud Control UpdateResource; sdk = type-specific SDK writer;
  // delete = Cloud Control DeleteResource (revert of an `added` out-of-band resource).
  kind: 'cc' | 'sdk' | 'delete';
  ops: PatchOp[]; // for `delete`: a single pseudo-op carrying the human label (never serialized)
}

export interface NotRevertable {
  displayId: string;
  resourceType: string;
  path: string;
  reason: string;
}

export interface RevertPlan {
  items: RevertItem[];
  notRevertable: NotRevertable[];
}

// A bare `null` array ELEMENT is a service read artifact (S3 echoes `TagFilters: [null]`
// inside every prefix-scoped IntelligentTiering / Metrics config element that declares no
// tag filter — #641). It is stripped from the DIFF view (cc-api-strip, symptom 1), but a
// Cloud Control revert of ANY property on the same resource sends an RFC6902 patch that CC
// applies to its OWN server-side model — which still contains the husk — and the provider's
// update validation then REJECTS the null element ("expected type JSONObject, found Null"),
// FAILING the revert of the unrelated property (#641 symptom 2). Emit `remove` ops that drop
// the husk from CC's model too. Restricted to a PURE-null array (every element null): remove
// the WHOLE property (absent = valid, and it dodges any minItems constraint an empty `[]`
// would trip). Removing a KEY never shifts an array index, so the ops are order-independent
// and safe to prepend to the real revert op. A REAL out-of-band edit produces non-null
// objects (a mixed array is left untouched — not the observed husk shape), so detection and
// legitimate reverts are unaffected.
function nullHuskRemovalOps(model: Record<string, unknown>): PatchOp[] {
  const ops: PatchOp[] = [];
  const walk = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every((v) => v === null || v === undefined)) {
        if (pointer !== '')
          ops.push({ op: 'remove', path: pointer, human: `strip null array husk at ${pointer}` });
        return; // a pure-null array has no non-null children to recurse into
      }
      value.forEach((v, i) => walk(v, `${pointer}/${i}`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  };
  walk(model, '');
  return ops;
}

// dotted finding path ("A.B.0.C") -> RFC6902 JSON pointer ("/A/B/0/C"). Split on dots at
// bracket depth 0 ONLY: an identity-keyed array segment `Prop[<id>]` may itself carry a `.`
// in the id — IAM names allow `.` (`svc.deploy`, `john.doe`), a Backup rule name may too —
// and splitting inside the bracket garbled the pointer (`Roles[my/role]` after escaping),
// which then no-op'd the IAM detach (burning a policy version) or threw on a Backup nested
// writer (#748). The bracket content stays in its owning segment so the writers' `\[(.+)\]$`
// parse recovers the full id.
function splitTopLevelDots(dotted: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of dotted) {
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
export function toPointer(dotted: string): string {
  return (
    '/' +
    splitTopLevelDots(dotted)
      .map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1'))
      .join('/')
  );
}

const DRIFT_TIERS = new Set(['declared', 'undeclared']);

// SecurityGroup rule property -> the buildSiblingSgRules side key, for the sibling-rule
// merge below (see RevertOptions.siblingSgRules).
const SG_REVERT_SIDE: Record<string, 'ingress' | 'egress'> = {
  SecurityGroupIngress: 'ingress',
  SecurityGroupEgress: 'egress',
};

export interface RevertOptions {
  // UNRECORDED undeclared values are removed only if this is set. Without it they
  // are reported as notRevertable (a bulk REMOVE of every undecided value that
  // slipped through noise subtraction would be destructive — fail-safe instead).
  removeUnrecorded?: boolean;
  // resourceType -> schema, so create-only property drift is reported as
  // notRevertable up front (an in-place patch would fail at apply time).
  schemas?: Map<string, SchemaInfo>;
  // The stack name — used to strip the stack/Stage prefix off each finding's construct path
  // for display (`withinStackPath`), matching what `cdkrd check` shows. Absent (unit calls) =
  // no strip, the full construct path.
  stackName?: string;
  // Rules declared by sibling standalone SecurityGroupIngress/Egress resources, keyed by the
  // SG's physical id. Reverting an AWS::EC2::SecurityGroup's SecurityGroupIngress/Egress is a
  // whole-array Cloud Control replacement; the live SG REFLECTS these sibling-declared rules,
  // so a revert built from only the inline declared rules would DELETE them (silent data loss
  // — a self-ref / peer / prefix-list rule wiped). Merge them back into the revert value so
  // CC preserves them. Same shape classify uses to subtract them (buildSiblingSgRules).
  siblingSgRules?: Record<string, { ingress: unknown[]; egress: unknown[] }>;
  // logicalId -> the RAW live model (read.live, pre-normalize). Used to sanitize a bare
  // `null` array-element husk out of a Cloud Control revert patch (#641 symptom 2): the husk
  // is stripped from the DIFF view (cc-api-strip) but persists in Cloud Control's OWN
  // server-side model, so a CC UpdateResource of ANY property on the same resource fails
  // model validation ("expected type JSONObject, found Null") unless the patch also drops it.
  liveByLogical?: Map<string, Record<string, unknown>>;
}

// True when a finding path is AT or UNDER any create-only schema path. The schema's
// `createOnlyPaths` are full dotted paths with `*` wildcards (e.g. `EncryptionConfiguration
// .KmsKey`, `PosixUser.*`, `Foo.*.Bar`); a finding's array-index segments (`[id]` or a
// numeric `.0`) align with those `*`. Segment-wise PREFIX membership, so a NESTED
// create-only property (parent mutable) is caught — the previous top-level-only check
// (`createOnly.has(firstSegment)`) missed those, and a `revert` then built an in-place
// patch that AWS rejects only at apply time (e.g. ECR `EncryptionConfiguration.KmsKey`,
// EFS AccessPoint `PosixUser.*`).
function pathSegments(path: string): string[] {
  return path
    .replace(/\[[^\]]*\]/g, '.*')
    .split('.')
    .filter((s) => s.length > 0);
}
function isUnderCreateOnly(findingPath: string, createOnlyPaths: readonly string[]): boolean {
  const f = pathSegments(findingPath);
  for (const co of createOnlyPaths) {
    const c = co.split('.');
    // Block when EITHER path is a prefix of the other (segment-wise; a `*` on either
    // side is a wildcard):
    //  - create-only path ⊆ finding path: the finding IS, or is nested under, a
    //    create-only property — an in-place patch on it is rejected (the nested
    //    create-only fix);
    //  - finding path ⊆ create-only path: the finding is a PARENT of a create-only
    //    property. drift-calculator emits a finding at the PARENT path for a
    //    length-/shape-changed array or object, so reverting it rewrites the whole
    //    subtree — INCLUDING the create-only descendant — which AWS also rejects as a
    //    replacement. Without this the revert proceeded and failed only at apply time
    //    (e.g. a length change in an object array whose elements carry a create-only
    //    sub-field, like EFS AccessPoint PosixUser under a replaced parent).
    const common = Math.min(c.length, f.length);
    let match = true;
    for (let i = 0; i < common; i++) {
      if (c[i] !== '*' && f[i] !== '*' && c[i] !== f[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export function buildRevertPlan(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  opts: RevertOptions = {}
): RevertPlan {
  const itemsByLogical = new Map<string, RevertItem>();
  const notRevertable: NotRevertable[] = [];
  const recorded = baseline?.recorded ?? [];
  // Collapse the per-element findings of an UNORDERED_OBJECT_ARRAY into ONE whole-array
  // replacement (see Finding.wholeArrayRevert): classify sorted both sides before the diff,
  // so each finding's array index is a SORTED position that does NOT map to the live raw
  // index — a Cloud Control sub-path patch would corrupt the wrong live element. Reverting
  // the WHOLE declared array converges deterministically regardless of live order. Track the
  // (logicalId, arrayPath) pairs already emitted so N element findings yield ONE op.
  const wholeArrayEmitted = new Set<string>();

  for (let f of findings) {
    // Show the construct path WITHIN the stack (stack/Stage prefix stripped), the same as the
    // check report — the revert banner already names the stack. Full path when unstripped.
    const displayId = f.constructPath
      ? withinStackPath(f.constructPath, opts.stackName ?? '')
      : f.logicalId;
    // Rewrite a per-element unordered-object-array finding to its whole-array path+value, and
    // drop the duplicates (one op per array). A finding whose path is ALREADY the whole array
    // (a length-mismatch drift, e.g. an SG whose live rules reflect sibling resources) is left
    // untouched — its revert is already a whole-array replace.
    if (f.tier === 'declared' && f.wholeArrayRevert && f.path !== f.wholeArrayRevert.path) {
      const waKey = `${f.logicalId}\0${f.wholeArrayRevert.path}`;
      if (wholeArrayEmitted.has(waKey)) continue;
      wholeArrayEmitted.add(waKey);
      f = { ...f, path: f.wholeArrayRevert.path, desired: f.wholeArrayRevert.value };
    }
    if (f.tier === 'deleted') {
      // a resource deleted out of band cannot be patched back — it must be
      // recreated by re-deploying the stack.
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'deleted — recreate via cdk deploy',
      });
      continue;
    }
    if (f.tier === 'added') {
      // PR4: an UNRECORDED added resource (no baseline entry — the user has not decided
      // on it) is excluded from the default plan, exactly like an unrecorded undeclared
      // value: a default revert would DELETE it (the destructive mirror of the
      // subtractive model). Refuse unless --remove-unrecorded; the fork is the same —
      // record it if the live resource should stay, --remove-unrecorded to delete it.
      if (f.unrecorded && !opts.removeUnrecorded) {
        notRevertable.push({
          displayId,
          resourceType: f.resourceType,
          path: f.path,
          reason:
            'unrecorded — record it if the live resource is right, or --remove-unrecorded to delete it',
        });
        continue;
      }
      // an out-of-band resource (not in the template) is reverted by DELETING it via
      // Cloud Control DeleteResource. f.physicalId is the CC identifier (the composite
      // `RestApiId|ResourceId[|HttpMethod]`). Modeled as a `delete`-kind item carrying a
      // single pseudo-op so the picker / count / filter machinery (which is op-based)
      // works unchanged; the apply path branches on kind and never serializes the op.
      if (!f.physicalId) {
        notRevertable.push({
          displayId,
          resourceType: f.resourceType,
          path: f.path,
          reason: 'no physical id',
        });
        continue;
      }
      itemsByLogical.set(f.logicalId, {
        logicalId: f.logicalId,
        displayId,
        resourceType: f.resourceType,
        physicalId: f.physicalId,
        kind: 'delete',
        ops: [
          {
            op: 'remove',
            path: '',
            human: `DELETE out-of-band ${f.resourceType} (not in your template)`,
          },
        ],
      });
      continue;
    }
    // A nested undeclared value whose path addresses an ARRAY ELEMENT (`Prop[<id>].sub`)
    // is detect/record-only, NOT revertable: `toPointer` builds a flat RFC6902 pointer by
    // splitting on '.', so the bracket survives as a literal segment (`/Prop[<id>]/sub`)
    // that targets a key named `Prop[<id>]`, not the array element — a malformed patch (the
    // same reason R78 abandoned index-based array patches). A PURE-DOTTED nested path
    // (`Environment.Variables.<key>` free-form map keys, or a sub-field of a declared
    // object) IS a valid pointer that Cloud Control applies read-modify-write (proven live
    // removing an out-of-band Lambda env var), so it falls through to the normal revert
    // below. Detect by PATH SHAPE, not Finding.nested: a baseline value REMOVED since
    // record is reconstructed (baseline-file.ts) WITHOUT the flag, but keeps its nested
    // path. A top-level undeclared path is a single key (never contains '.'/'['), and
    // declared drift is a different tier — so this never blocks a top-level revert.
    if (isUnrevertableNested(f) && !isManagedPolicyAttachmentMember(f) && !isNestedSdkWritable(f)) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'nested undeclared array-element value — detect/record only, not revertable',
      });
      continue;
    }
    if (!DRIFT_TIERS.has(f.tier)) continue; // only declared/undeclared are drift to revert
    // A SYNTHETIC integrity signal an SDK_SUPPLEMENTS reader computes (ELBv2 TrustStore
    // `CaCertificatesBundleSha256`, a digest of the live CA bundle content — #505) is not a
    // real AWS property, so it has no write target: a `remove` would fail. It exists only to
    // re-surface an out-of-band content swap as recordable undeclared drift; report it
    // detect/record-only.
    if (SYNTHETIC_READ_SIGNAL_PATHS[f.resourceType]?.includes(f.path)) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'read-only integrity signal — detect/record only, not revertable',
      });
      continue;
    }
    if (!f.physicalId) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'no physical id',
      });
      continue;
    }
    // CC-gap types are revertable only when we have a type-specific SDK writer — UNLESS
    // the override is a mere READ workaround on a CC-mutable type (see the set above),
    // in which case a CC UpdateResource revert is valid and we fall through to it.
    if (
      SDK_OVERRIDES[f.resourceType] &&
      !SDK_WRITERS[f.resourceType] &&
      !CC_REVERTABLE_DESPITE_READ_OVERRIDE.has(f.resourceType)
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'type not revertable yet',
      });
      continue;
    }
    // UNRECORDED values (R62): the user never decided on them, so a default plan
    // would otherwise REMOVE every such value (the subtractive model's failure
    // mode is "check is noisy", but the revert mirror of that is destructive).
    // Refuse unless --remove-unrecorded. Evaluated BEFORE the create-only guard
    // (R35): the fundamental blocker is "no revert target exists".
    // The reason wording is a FORK, not a sequence (R55): "record first, then
    // revert" reads as if record were a step toward reverting THESE values, but
    // recording them endorses them (they leave the report entirely) — record is
    // for values that are RIGHT; --remove-unrecorded is for values that are WRONG.
    if (f.tier === 'undeclared' && f.unrecorded && !opts.removeUnrecorded) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'unrecorded — record it if the live value is right, or --remove-unrecorded to remove it',
      });
      continue;
    }
    // create-only property: an in-place UpdateResource patch would be rejected (the
    // change needs a replacement) — report it now instead of failing at apply time.
    const schema = opts.schemas?.get(f.resourceType);
    if (schema && isUnderCreateOnly(f.path, schema.createOnlyPaths)) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: 'create-only property — change requires resource replacement',
      });
      continue;
    }
    // AWS::SSM::Parameter Tier: AWS forbids an advanced->standard downgrade via
    // PutParameter ("You can't downgrade a parameter from the advanced-parameter tier
    // to the standard-parameter tier" — live-proven), so reverting an out-of-band Tier
    // UPGRADE (the common case) would always fail at apply. Report it not-revertable
    // instead. The reverse (declared Advanced, restore an upgrade) is allowed and stays
    // revertable. Detection still works.
    if (
      f.resourceType === 'AWS::SSM::Parameter' &&
      f.path === 'Tier' &&
      f.actual === 'Advanced' &&
      f.desired !== 'Advanced'
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'SSM advanced-tier parameter cannot be downgraded to standard via update — delete and recreate it',
      });
      continue;
    }
    // R111: an IAM Role whose sibling AWS::IAM::Policy names could NOT be resolved
    // statically keeps the sibling-managed (DefaultPolicy) entries in its live
    // Policies array — classify could not separate them, and marked this finding
    // accordingly. The per-entry writer (writeIamRoleInlinePolicies) deletes every
    // prior entry the declared set drops, so reverting here would DELETE a managed
    // inline policy, removing real IAM grants. Refuse rather than wrong-write.
    if (f.siblingPolicyNames === 'unresolved') {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'inline policies are managed by a sibling AWS::IAM::Policy whose name could not be resolved — reverting could delete a managed policy',
      });
      continue;
    }
    // property-scoped SDK writers match the EXACT top-level finding path only
    // (deeper paths keep going through Cloud Control); a resource can therefore
    // split into one cc item and one sdk item per scoped path — key the grouping
    // by kind (+ path when prop-scoped) so each item resolves to ONE writer.
    const propScoped =
      !SDK_WRITERS[f.resourceType] && SDK_PROP_WRITERS[f.resourceType]?.[f.path] !== undefined;
    // A nested-path SDK writer (SDK_NESTED_WRITERS) reverts a DEEP sub-field its predicate
    // matches (e.g. ApiGateway Method integration knobs). Unlike propScoped, every matching
    // nested op of one resource batches into ONE sdk item (no path suffix in the key below) —
    // the writer translates them to the type's native granular API in one or few calls.
    const nestedScoped = !SDK_WRITERS[f.resourceType] && !propScoped && isNestedSdkWritable(f);
    // A JSON-string property (JSON_STRING_PROPS) can NEVER be reverted via Cloud Control:
    // CC re-serializes the JSON it stores into the provider's string field with spaces,
    // which the provider rejects (Config: "Blank spaces are not acceptable") — proven live.
    // So it MUST route to an SDK writer that writes the compact JSON string directly; if no
    // writer covers it, refuse rather than emit a CC patch that always fails at apply.
    if (
      JSON_STRING_PROPS[f.resourceType]?.has(f.path) &&
      !propScoped &&
      !SDK_WRITERS[f.resourceType]
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'JSON-string property — revert needs a type-specific SDK writer (not available yet)',
      });
      continue;
    }
    // A writeOnly property an SDK_SUPPLEMENTS reader makes COMPARABLE (so drift on it is
    // detected) but that Cloud Control still cannot sub-path patch: CC cannot navigate
    // INTO a writeOnly prop it can't read, so an `add` at a nested path (e.g. ECS
    // ServiceConnectConfiguration.Services.0.ClientAliases.0.DnsName) is rejected ("can
    // only be updated using 'add' operation") — only re-supplying the WHOLE top-level
    // prop works, which needs the full declared value threaded to a type-specific SDK
    // writer. Until that writer exists, report it not-revertable rather than emit a CC
    // patch that always fails at apply. Detection still works.
    if (
      WRITEONLY_NESTED_NO_CC_REVERT[f.resourceType]?.some(
        (p) => f.path === p || f.path.startsWith(`${p}.`)
      ) &&
      !SDK_WRITERS[f.resourceType] &&
      !propScoped &&
      !nestedScoped
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'writeOnly nested property — Cloud Control cannot patch a sub-path; revert needs a type-specific SDK writer (not available yet)',
      });
      continue;
    }
    const kind: RevertItem['kind'] =
      SDK_WRITERS[f.resourceType] || propScoped || nestedScoped ? 'sdk' : 'cc';

    // Reverting an SG's reflected SecurityGroupIngress/Egress is a whole-array CC replacement;
    // merge back the rules declared by sibling standalone SG-rule resources (which the live SG
    // reflects but the inline declared value omits) so the replacement does not DELETE them.
    let toRevert = f;
    const sgSide =
      f.tier === 'declared' && f.resourceType === 'AWS::EC2::SecurityGroup'
        ? SG_REVERT_SIDE[f.path]
        : undefined;
    if (sgSide && Array.isArray(f.desired) && f.physicalId) {
      const sib = opts.siblingSgRules?.[f.physicalId]?.[sgSide] ?? [];
      if (sib.length > 0) toRevert = { ...f, desired: [...(f.desired as unknown[]), ...sib] };
    }
    const op = revertOp(toRevert, recorded);
    const key = `${f.logicalId} ${kind}${propScoped ? ` ${f.path}` : ''}`;
    const item =
      itemsByLogical.get(key) ??
      ({
        logicalId: f.logicalId,
        displayId,
        resourceType: f.resourceType,
        physicalId: f.physicalId,
        kind,
        ops: [],
      } as RevertItem);
    item.ops.push(op);
    itemsByLogical.set(key, item);
  }

  // #641 symptom 2: a Cloud Control UpdateResource patch is applied by CC to its OWN
  // server-side model, which still carries any bare-null array husk the service echoes on
  // read (e.g. S3 `TagFilters: [null]`). Prepend `remove` ops that strip the husk so the
  // resulting model validates — otherwise the revert of an UNRELATED property on that
  // resource hard-fails with a model-validation error. Only `cc` items (SDK writers build
  // their own native payloads, never a CC patch); computed once per resource from its raw
  // live model.
  if (opts.liveByLogical) {
    for (const item of itemsByLogical.values()) {
      if (item.kind !== 'cc') continue;
      const live = opts.liveByLogical.get(item.logicalId);
      if (!live) continue;
      const huskOps = nullHuskRemovalOps(live);
      if (huskOps.length > 0) item.ops.unshift(...huskOps);
    }
  }

  // Order DELETE items LAST. A `delete` (out-of-band `added` resource) can be REFERENCED
  // by an undeclared property on another resource in the SAME plan — e.g. an ApiGateway
  // Method's undeclared `RequestValidatorId` points at the out-of-band RequestValidator the
  // plan also deletes. The provider rejects deleting a still-referenced resource, so the
  // dereference (property remove/revert via cc/sdk) MUST run before the delete. Apply order
  // == plan order (stack-actions iterates plan.items), so fix it here once: a STABLE
  // partition keeps every property write ahead of every delete while preserving the
  // relative order within each group (so the picker / dry-run preview match apply order).
  const ordered = [...itemsByLogical.values()];
  const items = [
    ...ordered.filter((i) => i.kind !== 'delete'),
    ...ordered.filter((i) => i.kind === 'delete'),
  ];
  return { items, notRevertable };
}

function revertOp(f: Finding, recorded: BaselineFile['recorded']): PatchOp {
  const pointer = toPointer(f.path);
  if (f.tier === 'declared') {
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      // Carry the current live value as `prior`, exactly like the undeclared branches
      // below. A property-scoped SDK writer that reverts PER ENTRY needs it:
      // `writeIamRoleInlinePolicies` deletes every inline policy present in `prior`
      // that the declared `value` no longer keeps. Without `prior` a declared
      // `/Policies` drift (a rogue inline policy added out of band → whole-array drift)
      // would re-PUT the declared policies but NEVER delete the rogue one — a silent,
      // security-relevant incomplete revert. Cloud Control serialization ignores
      // `prior`, and the ELB attribute-bag writers key off `attributeKey`, so this is
      // inert for them.
      prior: f.actual,
      ...(f.attributeKey !== undefined && { attributeKey: f.attributeKey }),
      human: `${f.path}${f.attributeKey ? `[${f.attributeKey}]` : ''} -> deployed-template value`,
    };
  }
  // undeclared: recorded before? restore that value; else it is a new addition -> remove.
  // `prior` carries the finding's current live value for property-scoped SDK
  // writers (per-entry revert); Cloud Control serialization ignores it.
  const wasRecorded = recorded.find((a) => a.logicalId === f.logicalId && a.path === f.path);
  if (f.actual === undefined && f.desired !== undefined) {
    // removed-undeclared finding: re-add the baseline value
    return {
      op: 'add',
      path: pointer,
      value: f.desired,
      human: `${f.path} -> restore baseline value`,
    };
  }
  if (wasRecorded) {
    return {
      op: 'add',
      path: pointer,
      value: wasRecorded.value,
      prior: f.actual,
      human: `${f.path} -> baseline value`,
    };
  }
  // A property the provider won't reset on absence (REVERT_SET_DEFAULT_PATHS): write the
  // known AWS default explicitly instead of a no-op `remove` (e.g. IAM Role
  // MaxSessionDuration). The value is the same KNOWN_DEFAULTS default that mutes an
  // at-default first sighting; if it is somehow absent we fall through to `remove`.
  const setDefaultKey = `${f.resourceType}\0${f.path}`;
  const knownDefault =
    KNOWN_DEFAULTS[f.resourceType]?.[f.path] ?? REVERT_SET_DEFAULT_VALUES[setDefaultKey];
  if (knownDefault !== undefined && REVERT_SET_DEFAULT_PATHS.has(setDefaultKey)) {
    return {
      op: 'add',
      path: pointer,
      value: knownDefault,
      prior: f.actual,
      human: `${f.path} -> AWS default (undeclared, not in baseline)`,
    };
  }
  // A NESTED value AWS materializes as a default (KNOWN_DEFAULT_PATHS, descended via
  // NESTED_ARRAY_IDENTITY): SET that default rather than `remove` it. Some providers keep
  // the existing value when a field is merely absent from the patch, so a bare `remove` is a
  // silent no-op (Route53Resolver FirewallDomainRedirectionAction — proven live). The
  // schemaPath normalizes the identity bracket to the `.*` the table is keyed by.
  const nestedDefault = KNOWN_DEFAULT_PATHS[f.resourceType]?.[f.path.replace(/\[[^\]]*\]/g, '.*')];
  if (nestedDefault !== undefined) {
    return {
      op: 'add',
      path: pointer,
      value: nestedDefault,
      prior: f.actual,
      human: `${f.path} -> AWS default (undeclared, not in baseline)`,
    };
  }
  return {
    op: 'remove',
    path: pointer,
    prior: f.actual,
    human: `${f.path} -> remove (undeclared, not in baseline)`,
  };
}

// Cloud Control applies an UpdateResource patch read-modify-write: it reads the
// current model, applies the patch, and hands the result to the provider's update
// handler. Read handlers CANNOT return write-only properties, so any write-only
// property absent from the patch vanishes from the desired state on every CC-routed
// update (cdkd #812). For most types the loss is silent; some hard-fail — e.g.
// reverting any property on an AWS::ECS::Service with a managed EBS volume drops the
// write-only `VolumeConfigurations` and UpdateService rejects with "Task definition
// has configuredAtLaunch volume but no volume configuration provided at runtime".
//
// Re-include every TOP-LEVEL write-only property present (and fully resolved) in the
// declared model that the patch does not already touch — restoring the CC
// read-modify-write contract. Only `cc`-kind items need this (SDK writers don't
// read-modify-write through Cloud Control). An UNRESOLVED declared value is skipped
// (we cannot send a sentinel); the patch then omits it exactly as before, so this
// never makes a borderline revert WORSE than today.
// Navigate a dotted path (e.g. `LoginProfile.Password`) in a declared model; returns
// undefined if any segment is missing or non-object. Used to re-include a NESTED
// write-only value from the template's intent.
function valueAtDottedPath(model: Record<string, unknown>, path: string): unknown {
  let node: unknown = model;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

export function writeOnlyReincludeOps(
  declared: Record<string, unknown> | undefined,
  schema: SchemaInfo | undefined,
  existingOps: PatchOp[]
): PatchOp[] {
  if (!declared || !schema || schema.writeOnlyPaths.length === 0) return [];
  const touched = new Set(existingOps.map((o) => o.path));
  const ops: PatchOp[] = [];
  // Iterate the FULL write-only paths, not just the top-level set: a NESTED write-only
  // property (AWS::IAM::User LoginProfile.Password, AWS::Amplify::App
  // BasicAuthConfig.Password) is never a top-level key, so the old top-level-only loop
  // re-included nothing — and a cc revert touching another property sent the parent
  // object (e.g. LoginProfile, which CC returns WITHOUT the write-only Password) to
  // UpdateResource, which RESET the credential. Re-include each resolved write-only value
  // present in the declared model from its template intent.
  for (const path of schema.writeOnlyPaths) {
    if (path.includes('*')) continue; // a wildcard (array-element) write-only — no single value to re-include
    // A property that is write-only AND create-only must NEVER enter an update patch:
    // Cloud Control hard-rejects any op on a create-only path ("createOnlyProperties
    // [...] cannot be updated"), failing the WHOLE revert at apply time — even though
    // the op only re-includes the property to satisfy the read-modify-write contract.
    // Omitting it is also safe: a create-only property is fixed at creation, so the
    // provider's update handler preserves it regardless of whether the patch carries it
    // (unlike a mutable write-only prop, it cannot silently vanish). Live-proven by an
    // AWS::ElastiCache::ReplicationGroup revert: CacheSubnetGroupName is both write-only
    // and create-only, so re-including it made every revert fail "createOnlyProperties
    // [/properties/CacheSubnetGroupName] cannot be updated".
    if (isUnderCreateOnly(path, schema.createOnlyPaths)) continue;
    const value = valueAtDottedPath(declared, path);
    if (value === undefined || value === UNRESOLVED || hasUnresolved(value)) continue;
    const pointer = toPointer(path);
    if (touched.has(pointer)) continue;
    ops.push({
      op: 'add',
      path: pointer,
      value,
      human: `${path} -> re-include write-only (Cloud Control read-modify-write contract)`,
    });
  }
  return ops;
}

// Cloud Control applies a `/Tags` patch read-modify-write: it reads the live model
// (which AWS augments with `aws:cloudformation:*` / `aws:*` managed tags), applies the
// patch, then hands the result to the provider's update handler. The handler diffs the
// resulting tag set against the live set and UNtags whatever is gone — so a bare
// `remove /Tags` (or an `add /Tags` whose value omits the managed tags) tells the
// provider to drop the `aws:*` tags too, which AWS hard-rejects: "aws: prefixed tag key
// names are not allowed for external use" (reproduced live reverting an out-of-band tag
// on an AWS::SNS::Topic). cdkrd strips `aws:*` tags from the COMPARE side
// (stripAwsTagsDeep), so the finding value never carries them; the revert must re-attach
// them on the WRITE side. For any cc-kind op on the top-level `/Tags` pointer, rewrite it
// to an `add /Tags` whose value is the intended user tags MERGED WITH the live `aws:*`
// tags — so the provider leaves the managed tags untouched and only the user tag changes.
// A `remove` becomes `add []`-of-managed-only; an `add` keeps its value plus the managed
// tags. With no managed tags present (or no live model) the op is returned unchanged, so
// this never alters a tag revert that wasn't at risk. Only the top-level `/Tags` pointer is
// rewritten here (LIST-shaped, the {Key,Value}[] shape awsManagedTags understands). A NESTED
// map-tag key op (`/Tags/<key>`, e.g. AWS::SSM::Parameter) does NOT need this rewrite and
// passes through unchanged: a single-key `remove`/`add` leaves every OTHER key — including
// the live `aws:*` managed ones — in Cloud Control's read-modify-write model, so the
// provider never untags the managed keys (proven live on an SSM Parameter).
const TAGS_POINTER = '/Tags';
function asTagList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function tagPreservingOps(
  ops: PatchOp[],
  liveRaw: Record<string, unknown> | undefined
): PatchOp[] {
  const liveTags = liveRaw?.['Tags'];
  // MAP-shaped Tags (key->value, e.g. AWS::SSM::Parameter): the managed tags are aws:*
  // KEYS. awsManagedTags only understood the {Key,Value}[] list shape, so a map-shaped
  // /Tags revert dropped the aws:* keys -> AWS rejects ("aws: prefixed tag key names are
  // not allowed for external use"). Mirror stripTagsWalk/isAllAwsTags and preserve them.
  if (liveTags !== null && typeof liveTags === 'object' && !Array.isArray(liveTags)) {
    const managedMap = Object.fromEntries(
      Object.entries(liveTags).filter(([k]) => k.startsWith('aws:'))
    );
    if (Object.keys(managedMap).length === 0) return ops;
    return ops.map((op) => {
      if (op.path !== TAGS_POINTER) return op;
      const userMap =
        op.op === 'add' &&
        op.value !== null &&
        typeof op.value === 'object' &&
        !Array.isArray(op.value)
          ? Object.fromEntries(
              Object.entries(op.value as Record<string, unknown>).filter(
                ([k]) => !k.startsWith('aws:')
              )
            )
          : {};
      return {
        op: 'add',
        path: TAGS_POINTER,
        value: { ...userMap, ...managedMap },
        ...(op.prior !== undefined && { prior: op.prior }),
        human: `${op.human} (preserving aws:* managed tags)`,
      };
    });
  }
  const managed = awsManagedTags(liveTags);
  if (managed.length === 0) return ops; // nothing managed to protect — leave ops as-is
  return ops.map((op) => {
    if (op.path !== TAGS_POINTER) return op;
    // user (non-managed) tags the revert wants to KEEP: an `add` keeps its value's
    // tags, a `remove` keeps none — either way, drop any aws:* entry from the value
    // (it should never carry one, but be defensive — same per-element predicate as
    // awsManagedTags) and re-attach the live managed set.
    const userTags =
      op.op === 'add' ? asTagList(op.value).filter((t) => awsManagedTags([t]).length === 0) : [];
    return {
      op: 'add',
      path: TAGS_POINTER,
      value: [...userTags, ...managed],
      ...(op.prior !== undefined && { prior: op.prior }),
      human: `${op.human} (preserving aws:* managed tags)`,
    };
  });
}

// Service-echoed EMPTY sub-arrays that the service itself REJECTS when a Cloud Control
// UpdateResource re-sends them (#481): the CC read of a VpcLattice Rule echoes
// `Match.HttpMatch.HeaderMatches: []` for a rule declared with only a path match (the
// common shape), and the CC update handler folds its own read-back state into
// `UpdateRule` — which requires headerMatches to have >= 1 members. So ANY patch on such
// a rule, even a Priority-only revert, failed with "Value '[]' at
// 'match.httpMatch.headerMatches' failed to satisfy constraint" (reproduced live). The
// CFn schema does not annotate the constraint (no minItems on HeaderMatches), so the
// pointers are curated per type. An appended `remove` op drops the echoed empty array
// from the handler's desired state; the service treats an absent headerMatches as "no
// header matches", which is exactly what the empty echo meant.
// A pointer segment may be `*` — an ARRAY WILDCARD matching every index — so a husk that
// sits INSIDE an array element is reachable (#506: ImageBuilder DistributionConfiguration
// echoes `TargetAccountIds: []` inside EACH Distributions[i].AmiDistributionConfiguration,
// out of reach of a static object-only pointer). Each `*` fans the pointer out to one
// concrete pointer per live index.
export const CC_UPDATE_REJECTED_EMPTY_PATHS: Record<string, readonly string[]> = {
  'AWS::VpcLattice::Rule': ['/Match/HttpMatch/HeaderMatches'],
  // ImageBuilder folds its own read-back state into UpdateDistributionConfiguration, and
  // the handler rejects the echoed `targetAccountIds: []` inside every distribution's
  // amiDistributionConfiguration — so ANY patch (even a Description-only revert) failed
  // with "The value supplied for parameter 'distributions[0].amiDistributionConfiguration.
  // targetAccountIds' is not valid" (reproduced live, 2026-07-03). Dropping the echoed
  // empty array lets the handler treat it as absent (no cross-account distribution), which
  // is what the empty echo meant. The CC read echoes the sibling FastLaunchConfigurations /
  // LaunchTemplateConfigurations arrays as `[]` too (corpus-observed), and they carry the
  // same "must be non-empty when present" shape — so they are included pre-emptively.
  // Stripping is a safe no-op regardless: the fail-safe gate only drops a live value that is
  // ALREADY an empty array (a populated array is real data and never touched), and an absent
  // array means "no config", exactly what the echoed `[]` meant. TargetAccountIds is the
  // live-proven rejection; the siblings guard against the same wall on a distribution that
  // sets one of them.
  'AWS::ImageBuilder::DistributionConfiguration': [
    '/Distributions/*/AmiDistributionConfiguration/TargetAccountIds',
    '/Distributions/*/FastLaunchConfigurations',
    '/Distributions/*/LaunchTemplateConfigurations',
  ],
  // Lambda EventInvokeConfig with no destinations configured (the common
  // `configureAsyncInvoke({ retryAttempts, maxEventAge })` shape): Cloud Control's read
  // echoes empty destination HUSKS `DestinationConfig: {OnSuccess: {}, OnFailure: {}}`, and
  // the CC update handler folds its own read-back state into the update — but the schema
  // requires a `Destination` inside each OnSuccess/OnFailure, so ANY patch (even a
  // MaximumRetryAttempts-only revert) failed with "required key [Destination] not found"
  // (#650, live-proven 2026-07-08). Unlike the array husks above these are empty OBJECTS
  // `{}`, so the strip gate below also drops an empty PLAIN OBJECT (not just an empty array).
  // Dropping the husk lets the handler treat the destination as absent (no destination),
  // which is exactly what the `{}` echo meant.
  'AWS::Lambda::EventInvokeConfig': [
    '/DestinationConfig/OnSuccess',
    '/DestinationConfig/OnFailure',
  ],
};
// Expand a JSON pointer that MAY contain `*` array-wildcard segments into a {pointer, value}
// pair for every matching live node. A `*` matches each index of an array node; a normal
// segment indexes an object. A wildcard-free pointer yields one pair (or none if a segment
// is absent). Pure.
function expandPointer(model: unknown, pointer: string): { pointer: string; value: unknown }[] {
  let frontier: { path: string[]; node: unknown }[] = [{ path: [], node: model }];
  for (const seg of pointer.split('/').slice(1)) {
    const next: { path: string[]; node: unknown }[] = [];
    for (const { path, node } of frontier) {
      if (seg === '*') {
        if (Array.isArray(node))
          node.forEach((el, i) => next.push({ path: [...path, String(i)], node: el }));
      } else if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
        next.push({ path: [...path, seg], node: (node as Record<string, unknown>)[seg] });
      }
    }
    frontier = next;
  }
  return frontier.map(({ path, node }) => ({ pointer: `/${path.join('/')}`, value: node }));
}
// A schema-invalid EMPTY husk the service echoes on read but rejects when re-sent on an
// update: an empty ARRAY `[]` (VpcLattice / ImageBuilder above) or an empty PLAIN OBJECT
// `{}` (Lambda EventInvokeConfig DestinationConfig husks, #650). A populated array/object is
// real data and is NEVER dropped; an absent pointer needs no strip.
function isEmptyHusk(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

// Extra `remove` ops for a cc-kind item on a type in the table above. Fail-safe gates:
// the LIVE model must carry the pointer as an EMPTY husk (an empty array `[]` or empty
// object `{}` — a populated one is real data and is never dropped; an absent pointer needs
// no strip and a `remove` on it would itself fail), and no planned op may already rewrite
// the pointer or an ANCESTOR of it (such a rewrite replaces what lives there, so a trailing
// remove would target a path the patch may have just dropped).
export function rejectedEmptyStripOps(
  resourceType: string,
  ops: PatchOp[],
  liveRaw: Record<string, unknown> | undefined
): PatchOp[] {
  const pointers = CC_UPDATE_REJECTED_EMPTY_PATHS[resourceType];
  if (!pointers || !liveRaw || ops.length === 0) return [];
  const out: PatchOp[] = [];
  for (const pointer of pointers) {
    for (const { pointer: concrete, value } of expandPointer(liveRaw, pointer)) {
      if (!isEmptyHusk(value)) continue;
      const covered = ops.some((o) => concrete === o.path || concrete.startsWith(`${o.path}/`));
      if (covered) continue;
      out.push({
        op: 'remove',
        path: concrete,
        human: `${concrete.slice(1).replaceAll('/', '.')} -> drop service-echoed empty husk (service rejects it on update)`,
      });
    }
  }
  return out;
}

// A JSON pointer carries a NUMERIC array-index segment when any `/`-separated segment is
// all digits (e.g. `/CacheBehaviors/0/ViewerProtocolPolicy` -> the `0`). Such a pointer
// is POSITIONAL: it addresses "whatever element sits at index N right now", not a stable
// identity. If the live array shifted between when classify computed the index and when
// the user confirms the revert (a prepend/reorder in a same-length object array during the
// confirm-prompt window), an op at `/Prop/0/Sub` silently lands on a DIFFERENT element and
// corrupts a sibling (#762).
function hasArrayIndexSegment(pointer: string): boolean {
  return pointer.split('/').some((seg) => /^\d+$/.test(seg));
}

/**
 * Serialize a RevertItem's ops to an RFC6902 PatchDocument string for Cloud Control.
 *
 * #762: the Cloud Control path had no analogue of the SDK-writer guard (writers.ts
 * `desiredModel` re-reads + re-canonicalizes the live model so an indexed op lands on the
 * SAME element classify diffed). For an INDEX-BEARING pointer we emit a preceding RFC6902
 * `test` precondition asserting the addressed location still equals the value classify saw
 * (`op.prior` = the finding's live `actual`). Cloud Control accepts standard RFC6902 and
 * evaluates `test` atomically before the mutation, so a shifted index makes it REJECT the
 * whole patch instead of writing the wrong element — fail-closed, the same intent as the
 * writer-path re-read. Scalar non-indexed pointers carry no aliasing risk (a named property
 * is stable regardless of array order), so they get NO `test` op — the patch stays minimal.
 */
export function toPatchDocument(item: RevertItem): string {
  const doc: { op: string; path: string; value?: unknown }[] = [];
  for (const { op, path, value, prior } of item.ops) {
    // Guard only index-bearing pointers, and only when we know the value classify diffed
    // against (`prior` = f.actual). A `test` with an `undefined` value is meaningless
    // (RFC6902 has no "undefined"): skip it rather than assert an absent value.
    if (hasArrayIndexSegment(path) && prior !== undefined) {
      doc.push({ op: 'test', path, value: prior });
    }
    doc.push(op === 'remove' ? { op, path } : { op, path, value });
  }
  return JSON.stringify(doc);
}

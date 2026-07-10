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
import { GETTEMPLATE_MASK_NOTE } from '../diff/classify.js';
import { TAG_PROPERTY_NAMES } from '../normalize/cc-api-strip.js';
import { hasUnresolved, UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import {
  awsManagedTags,
  isCfnTemplateNonAsciiMask,
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
// properties) as an integrity signal for a value that is otherwise unreadable —
// AWS::ElasticLoadBalancingV2::TrustStore `CaCertificatesBundleSha256` (a digest of the
// live CA bundle content, #505), AWS::Lambda::Function `CodeSha256` (the writeOnly function
// code's digest from lambda:GetFunction, #646), and AWS::Glue::Job `ScriptSha256` (a
// fetch-and-hash of the ETL script at S3 Command.ScriptLocation, #1346). They surface as
// undeclared drift that `record` snapshots (so a later content/code/script swap re-surfaces),
// but they have no write target, so a revert on one is reported not-revertable rather than
// emitting a `remove` that always fails. For CodeSha256 / ScriptSha256 the original bytes are
// gone, so the only remedy is to redeploy / re-upload the intended code.
const SYNTHETIC_READ_SIGNAL_PATHS: Record<string, readonly string[]> = {
  'AWS::ElasticLoadBalancingV2::TrustStore': ['CaCertificatesBundleSha256'],
  'AWS::Lambda::Function': ['CodeSha256'],
  'AWS::Glue::Job': ['ScriptSha256'],
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
// Exported so a guard test can assert every KNOWN_DEFAULTS UserPool fold has a matching
// entry here (#702): UpdateUserPool ignores an omitted property, so a fold WITHOUT an RSDP
// entry silently reverts as a no-op `remove`. Keyed `${resourceType}\0${path}`.
export const REVERT_SET_DEFAULT_PATHS = new Set<string>([
  'AWS::IAM::Role\0MaxSessionDuration',
  // IAM UpdateRole ignores an omitted Description the same way it ignores an omitted
  // MaxSessionDuration (both are UpdateRole params) — a `remove` revert of an out-of-band
  // description is a silent no-op, so write the empty-string default (from KNOWN_DEFAULTS)
  // back explicitly. Precedent: AWS::Lambda::Alias Description below (UpdateAlias ignores an
  // omitted description → an explicit "" write is needed). (Role Path is create-only → not
  // reachable as undeclared drift, correctly barred and NOT listed here.)
  'AWS::IAM::Role\0Description',
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
  // Same UpdateServer omit-ignored behavior for the other mutable server-config props that
  // KNOWN_DEFAULTS folds — all set via the same UpdateServer call proven to keep an omitted
  // property. Write their KNOWN_DEFAULTS defaults back explicitly so an out-of-band change
  // reverts as a set-to-default rather than a silent `remove` no-op. IpAddressType ("IPV4")
  // is a scalar; ProtocolDetails ({PassiveIp:'AUTO', SetStatOption:'DEFAULT',
  // TlsSessionResumptionMode:'ENFORCED'}) and S3StorageOptions
  // ({DirectoryListingOptimization:'DISABLED'}) are whole-object defaults. (Domain is
  // create-only → barred and NOT listed here.)
  'AWS::Transfer::Server\0IpAddressType',
  'AWS::Transfer::Server\0ProtocolDetails',
  'AWS::Transfer::Server\0S3StorageOptions',
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
  // UpdateTracker likewise ignores an omitted PricingPlan (same omit-ignored provider
  // behavior) — write the "RequestBasedUsage" default (from KNOWN_DEFAULTS) back explicitly.
  // (Deprecated field, near-zero drift; listed for completeness so a `remove` no-op cannot
  // leave a non-converging revert.)
  'AWS::Location::Tracker\0PricingPlan',
  // Amazon Location UpdatePlaceIndex likewise IGNORES an omitted DataSourceConfiguration
  // (live-observed 2026-07-07: a `remove` revert of an out-of-band IntendedUse=Storage
  // reported SUCCESS yet the live value stayed Storage — "1 drift remain"). Write the whole
  // {IntendedUse:"SingleUse"} default object back explicitly (2nd object-valued entry after
  // AppRunner) so revert converges.
  'AWS::Location::PlaceIndex\0DataSourceConfiguration',
  // UpdatePlaceIndex likewise ignores an omitted PricingPlan — write the "RequestBasedUsage"
  // default (from KNOWN_DEFAULTS) back explicitly (deprecated field, twin of the Tracker
  // PricingPlan entry above; listed for completeness).
  'AWS::Location::PlaceIndex\0PricingPlan',
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
  // KNOWN_DEFAULTS addition needs a matching entry here (a guard test asserts this pairing so
  // a future fold cannot silently regress to a `remove` no-op — see revert-cognito-rsdp-702).
  'AWS::Cognito::UserPool\0Policies',
  // The remaining six UserPool KNOWN_DEFAULTS folds (#702, addendum 2026-07-10): each has a
  // fold but was still planning a bare `remove` that UpdateUserPool ignores. Two are
  // security-relevant out of band — EmailConfiguration switched to a DEVELOPER SES identity
  // (mail interception) and AccountRecoverySetting weakened (account-takeover surface) would
  // be detected yet never revertable without an explicit set-default write. The set-default
  // value for each resolves from KNOWN_DEFAULTS (VerificationMessageTemplate
  // {DefaultEmailOption:'CONFIRM_WITH_CODE'} / AccountRecoverySetting {RecoveryMechanisms:[...]}
  // / EmailConfiguration {EmailSendingAccount:'COGNITO_DEFAULT'} / KeyConfiguration
  // {KeyType:'AWS_OWNED_KEY'} / IssuerConfiguration {Type:'ORIGINAL'} /
  // WebAuthnFactorConfiguration 'SINGLE_FACTOR').
  'AWS::Cognito::UserPool\0VerificationMessageTemplate',
  'AWS::Cognito::UserPool\0AccountRecoverySetting',
  'AWS::Cognito::UserPool\0EmailConfiguration',
  'AWS::Cognito::UserPool\0KeyConfiguration',
  'AWS::Cognito::UserPool\0IssuerConfiguration',
  'AWS::Cognito::UserPool\0WebAuthnFactorConfiguration',
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
  // EC2 ModifyClientVpnEndpoint is a SELECTIVE-update API routed through an SDK writer
  // (CLIENT_VPN_SCALAR_PARAMS): a `remove` deletes the key from the desired model, the
  // writer skips the now-undefined param, and nothing is sent — Cloud Control-style
  // "converge on omit" never applies (#912). Write the KNOWN_DEFAULTS defaults back
  // explicitly so an out-of-band change converges. VpnPort (443) and
  // DisconnectOnSessionTimeout (true) pull their values from KNOWN_DEFAULTS. SplitTunnel
  // folds `atDefault` as a trivial-empty `false` (no KNOWN_DEFAULTS value), so an OOB
  // `true` is otherwise unrevertable — its `false` default comes from
  // REVERT_SET_DEFAULT_VALUES below, the EnableDns64 pattern.
  'AWS::EC2::ClientVpnEndpoint\0VpnPort',
  'AWS::EC2::ClientVpnEndpoint\0DisconnectOnSessionTimeout',
  'AWS::EC2::ClientVpnEndpoint\0SplitTunnel',
  // DocDB ModifyDBCluster / ModifyDBInstance are SELECTIVE-update APIs routed through SDK
  // writers whose allowlists include these props: a `remove` empties the desired model and
  // the writer sends nothing (`if (!any) return`) — a silent no-op (#912). Write the
  // KNOWN_DEFAULTS defaults back explicitly. Port (27017) and BackupRetentionPeriod (1)
  // pull from KNOWN_DEFAULTS; DeletionProtection folds `atDefault` as trivial-empty `false`
  // (no KNOWN_DEFAULTS value — an OOB `true` is a real blocking mutation), so its `false`
  // default comes from REVERT_SET_DEFAULT_VALUES below. DBInstance CACertificateIdentifier
  // ('rds-ca-rsa2048-g1') pulls from KNOWN_DEFAULTS (explicit write reboots the instance
  // with ApplyImmediately).
  'AWS::DocDB::DBCluster\0Port',
  'AWS::DocDB::DBCluster\0BackupRetentionPeriod',
  'AWS::DocDB::DBCluster\0DeletionProtection',
  'AWS::DocDB::DBInstance\0CACertificateIdentifier',
  // OpenSearch UpdateDomainConfig is a documented SELECTIVE API routed through an SDK
  // writer (OS_UPDATABLE_OPTIONS): a `remove` makes the option undefined, the writer omits
  // it, and the API fired with only {DomainName} is a successful no-op (#912) — omit can
  // NEVER converge, only an explicit set-default can. All four fold `atDefault` from the
  // top-level KNOWN_DEFAULTS, so the set-default value comes from there. (DeploymentStrategyOptions
  // is additionally absent from OS_UPDATABLE_OPTIONS — the writer allowlist gap #804 does
  // not name — so its convergence still depends on that writer table; this entry ensures
  // revert PLANS the correct set-default rather than a bare `remove`.)
  'AWS::OpenSearchService::Domain\0SnapshotOptions',
  'AWS::OpenSearchService::Domain\0AdvancedOptions',
  'AWS::OpenSearchService::Domain\0IPAddressType',
  'AWS::OpenSearchService::Domain\0DeploymentStrategyOptions',
]);

// Set-default values for REVERT_SET_DEFAULT_PATHS entries whose default is a plain constant
// that folds `atDefault` via the CFn SCHEMA default rather than KNOWN_DEFAULTS (so it is
// absent from that table). Consulted as a FALLBACK when KNOWN_DEFAULTS carries no value for
// the path — KNOWN_DEFAULTS stays the primary source. Keyed `${resourceType}\0${path}`.
const REVERT_SET_DEFAULT_VALUES: Record<string, unknown> = {
  'AWS::EC2::Subnet\0EnableDns64': false,
  // ClientVpnEndpoint SplitTunnel and DocDB DBCluster DeletionProtection both fold
  // `atDefault` as a trivial-empty `false` (no KNOWN_DEFAULTS value source), so their
  // revert set-default value is the plain constant `false` here — the EnableDns64 pattern.
  'AWS::EC2::ClientVpnEndpoint\0SplitTunnel': false,
  'AWS::DocDB::DBCluster\0DeletionProtection': false,
};

/**
 * #1072 — the staleness WATCH-LIST for REVERT_SET_DEFAULT_PATHS entries whose set-default
 * WRITE value is a MOVING AWS default (a create-time default AWS advances over time), not a
 * stable constant. Failure mode: when AWS moves the default and our pin lags, reverting an
 * undeclared out-of-band change WRITES yesterday's default to AWS — and because the written
 * value still equals the (also-stale) fold pin, the post-revert `check` folds it `atDefault`
 * and reports CLEAN, so the wrong write is INVISIBLE. For a security-typed path that is a
 * silent DOWNGRADE write (e.g. an old TLS policy). Unlike a fold-only pin (whose rot
 * self-surfaces as a returning first-run FP via the #581 note), a revert-write pin's rot is
 * NOT self-surfacing — hence this explicit list.
 *
 * This is a REVIEW artifact, not a runtime check (staleness can only be confirmed against
 * live AWS): the guard test `revert-pin-staleness-1072` asserts every key here is a real
 * REVERT_SET_DEFAULT_PATHS entry (so a rename/removal of a pin can't silently drop it from
 * tracking) and that the resolved write value still matches. RE-VERIFY CADENCE: re-check each
 * `value` against a fresh live deploy on the noted `moveAxis` at least quarterly, and
 * whenever AWS announces a move; bump `lastVerified` when confirmed. Fold-only moving pins
 * (ApiGateway RestApi SecurityPolicy, Logs::Delivery RecordFields, Cognito IdP token_url,
 * EKS SupportType, Bedrock Guardrail tier configs) live in noise.ts / KNOWN_DEFAULT_PATHS and
 * are self-surfacing (failure mode 1) — tracked there, not here.
 */
export interface MovingRevertPin {
  value: unknown; // the current pinned write value (must equal the KNOWN_DEFAULTS/VALUES source)
  lastVerified: string; // ISO date the value was last confirmed against a fresh live deploy
  moveAxis: string; // why/how AWS may move this default (what to watch for)
}
export const MOVING_REVERT_PINS: Record<string, MovingRevertPin> = {
  'AWS::Transfer::Server\0SecurityPolicyName': {
    value: 'TransferSecurityPolicy-2018-11',
    lastVerified: '2026-07-07',
    moveAxis:
      'AWS ships newer named TLS policies (2020-06 … 2024-01) and pushes TLS 1.2+ floors; a create-default bump would make revert write a TLS 1.0/1.1-era policy — a security downgrade.',
  },
  'AWS::Cognito::UserPool\0UserPoolTier': {
    value: 'ESSENTIALS',
    lastVerified: '2026-07-10',
    moveAxis:
      'AWS repriced/renamed the pool feature plans once already (advanced-security → feature plans, Nov 2024); a rename/re-default makes revert write a stale billing tier.',
  },
  'AWS::DocDB::DBInstance\0CACertificateIdentifier': {
    value: 'rds-ca-rsa2048-g1',
    lastVerified: '2026-07-10',
    moveAxis:
      'RDS/DocDB rotate the default server CA on a published schedule; a bump makes revert write a superseded CA identifier (reboots the instance onto an old cert).',
  },
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
  // #967: a CONTRACT op — plumbing that exists ONLY to keep the Cloud Control patch
  // valid (e.g. a null-array-husk strip, #641), NOT a revert the user chose. It
  // corresponds to no finding, so it is NEVER offered as a standalone selectable row
  // in the interactive multiselect and is NOT counted as user intent — it rides along
  // an item only while that item still carries ≥1 real (non-contract) op. The KEY
  // invariants: a real revert op can never be sent without its coupled contract op, and
  // a contract op can never be sent alone as a user-chosen write.
  contract?: boolean;
  human: string; // one-line description for the plan display
}

// #967: a CONTRACT op is plumbing that keeps the CC patch valid (a null-husk strip),
// NOT a revert the user chose. The interactive multiselect must neither offer it as a
// standalone selectable row nor count it as user intent — it rides an item only while
// that item still carries a real (non-contract) op. Threaded as a predicate (not a
// fragile path-string match) so any future contract-classed op is covered by tagging it.
export function isContractOp(op: PatchOp): boolean {
  return op.contract === true;
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
  // #853: the RAW live model (read.live, pre-normalize) for this resource, attached to cc-kind
  // items so toPatchDocument sources an index-bearing `test` op's value from the raw domain CC
  // evaluates against — NOT the canonicalized `op.prior` (= f.actual), which mismatches CC's raw
  // model whenever normalization transformed the tested subtree (sorted id arrays, canonicalized
  // policy docs, base64-decoded WAF SearchString). Never serialized to Cloud Control.
  liveRaw?: Record<string, unknown>;
}

export interface NotRevertable {
  displayId: string;
  resourceType: string;
  path: string;
  reason: string;
}

// Keys (`logicalId\0path`) of the GetTemplate-masked readGap findings classify demoted
// (#1341) — the positive record of WHERE the declared template carries `?`-masked
// non-ASCII text. Used to refuse a whole-array revert whose declared array contains such
// a masked element: the finding's own desired/actual pair can't reveal it (desired is
// the whole array, actual just the edited leaf), but a sibling masked readGap UNDER the
// same array path proves the write would stamp `?`s over intact live text. Exported so
// stack-actions can compute the keys over the FULL reconciled findings and pass them via
// RevertOptions.maskReadGapKeys — the interactive per-finding flow narrows the plan
// input to the picked findings only, which never include (unpickable) readGaps.
export function maskReadGapKeysOf(findings: readonly Finding[]): Set<string> {
  const keys = new Set<string>();
  for (const f of findings) {
    if (f.tier === 'readGap' && f.note === GETTEMPLATE_MASK_NOTE) {
      keys.add(`${f.logicalId}\0${f.path}`);
    }
  }
  return keys;
}

// Does the DECLARED (desired) value carry a GetTemplate non-ASCII `?`-mask anywhere,
// judged against the intact live value? A declared drift whose desired came from
// GetTemplate with non-ASCII text masked to `?` (and no local-synth recovery — see
// desired/recover-nonascii.ts) can still surface when a GENUINE edit exists alongside
// the masks (a mask-ONLY difference is demoted to readGap in classify and never reaches
// the plan). Writing that desired back would fix the edited leaf but CORRUPT every
// masked leaf — stamping literal `?` runs over the live non-ASCII text — so the plan
// must refuse it. Walk desired and live in parallel and report true when ANY aligned
// string-leaf pair is a mask (isCfnTemplateNonAsciiMask: exact ASCII skeleton + length,
// >=1 non-ASCII — a legit literal `?` never matches an ASCII live value); when both
// leaves are JSON documents (an SFN DefinitionString, a JSON-string prop), parse and
// walk INSIDE them, since the masked leaf hides within the encoded text. Structurally
// divergent branches (the genuine edit) simply don't align — fail-open by design: a
// masked leaf whose OWN text was also edited is undetectable in principle (the intact
// declared text is unrecoverable), and blocking must only fire on positive evidence.
// Unlike the #1225 write-time guard this compares f.desired vs f.actual — BOTH from
// classify's one normalized domain, never a fresh live read — so there is no
// writer-shape mismatch to false-abort on (the trap that sank #1225 → revert #1243).
export function hasGetTemplateMaskedLeaf(desired: unknown, live: unknown): boolean {
  if (typeof desired === 'string' && typeof live === 'string') {
    if (isCfnTemplateNonAsciiMask(desired, live)) return true;
    // Not mask-aligned as raw strings — if both encode JSON documents, the mask may sit
    // on a leaf inside them (alongside a genuine edit that broke whole-string alignment).
    try {
      return hasGetTemplateMaskedLeaf(JSON.parse(desired), JSON.parse(live));
    } catch {
      return false;
    }
  }
  if (Array.isArray(desired) && Array.isArray(live)) {
    const n = Math.min(desired.length, live.length);
    for (let i = 0; i < n; i++) if (hasGetTemplateMaskedLeaf(desired[i], live[i])) return true;
    return false;
  }
  if (
    typeof desired === 'object' &&
    desired !== null &&
    typeof live === 'object' &&
    live !== null &&
    !Array.isArray(desired) &&
    !Array.isArray(live)
  ) {
    for (const key of Object.keys(desired as Record<string, unknown>)) {
      if (!Object.hasOwn(live, key)) continue;
      if (
        hasGetTemplateMaskedLeaf(
          (desired as Record<string, unknown>)[key],
          (live as Record<string, unknown>)[key]
        )
      )
        return true;
    }
    return false;
  }
  return false;
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
// would trip). A pure-null array usually sits under an OBJECT key (`.../TagFilters`), whose
// remove never shifts an array index — but it can ALSO be an ARRAY ELEMENT itself
// (`{ Rules: [[null], [null], { Keep: 1 }] }` -> `/Rules/0`, `/Rules/1`), whose remove IS
// positional: RFC6902 `remove` splices the array, so applying `/Rules/0` first shifts every
// later index left and `/Rules/1` would then delete the real-data element (#968). Every op
// emitted here removes a DISJOINT pure-null subtree (the walk returns without recursing once
// a pure-null array is found, so no op is an ancestor of another), so sorting them into
// DESCENDING document order makes each remove address a position at or after every op still
// to be applied — removing it can never shift a not-yet-applied array index. This keeps the
// ops safe to prepend to the real revert op AND safe among themselves. A REAL out-of-band
// edit produces non-null objects (a mixed array is left untouched — not the observed husk
// shape), so detection and legitimate reverts are unaffected.
function nullHuskRemovalOps(model: Record<string, unknown>): PatchOp[] {
  const ops: PatchOp[] = [];
  const walk = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every((v) => v === null || v === undefined)) {
        if (pointer !== '')
          ops.push({
            op: 'remove',
            path: pointer,
            // #967: contract plumbing, not a user-chosen revert — never independently
            // selectable in the interactive multiselect, never counted as user intent.
            contract: true,
            human: `strip null array husk at ${pointer}`,
          });
        return; // a pure-null array has no non-null children to recurse into
      }
      value.forEach((v, i) => walk(v, `${pointer}/${i}`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  };
  walk(model, '');
  ops.sort((a, b) => compareDocOrderDescending(a.path, b.path));
  return ops;
}

// Total-order comparator putting two JSON pointers into DESCENDING document order: at the
// first differing segment, larger index / lexically-greater key first (a numeric-vs-numeric
// pair compares numerically so `/Rules/10` sorts before `/Rules/2`); if one pointer is a
// prefix of the other, the deeper one first. Used to order `remove` ops so an earlier op
// never splices an array position out from under a later op (#968).
function compareDocOrderDescending(a: string, b: string): number {
  const as = a.split('/').slice(1);
  const bs = b.split('/').slice(1);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] === bs[i]) continue;
    const ai = Number(as[i]);
    const bi = Number(bs[i]);
    const bothNumeric =
      as[i] !== '' && bs[i] !== '' && Number.isInteger(ai) && Number.isInteger(bi);
    if (bothNumeric) return bi - ai;
    return as[i]! < bs[i]! ? 1 : -1;
  }
  return bs.length - as.length;
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
  // `logicalId\0path` keys of GetTemplate-masked readGaps (maskReadGapKeysOf) computed
  // over the FULL reconciled findings. buildRevertPlan also collects them from its own
  // input, but the interactive per-finding flow narrows that input to the picked
  // findings (readGaps are unpickable), so the caller passes the full-set keys here.
  maskReadGapKeys?: ReadonlySet<string>;
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
  // Where the declared template carries GetTemplate-masked non-ASCII text: the demoted
  // readGaps in this plan's own input plus the caller-supplied full-set keys (the
  // interactive flow narrows the input to picked findings, which exclude readGaps).
  const maskGapKeys = maskReadGapKeysOf(findings);
  for (const k of opts.maskReadGapKeys ?? []) maskGapKeys.add(k);
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
      // #764: a RECORDED (endorsed) `added` resource that later CHANGED stays tier
      // `added` with `unrecorded` UNSET — applyBaseline keeps it with the recorded baseline
      // model on `desired` + a "changed since record" note (the ONLY way an added finding
      // carries a `desired`). Reverting it still has only ONE lever — DeleteResource of the
      // WHOLE resource — so `revert --yes` would DELETE an endorsed out-of-band
      // DBInstance/ECS Service with no delete-specific gate (the interactive multiselect's
      // unselected-by-default `(DELETE)` rows are the real gate, skipped under --yes). That
      // is the destructive mirror of the undeclared asymmetry: a recorded VALUE that
      // changed is RESTORED to the baseline, but a recorded RESOURCE that changed was being
      // DELETED. Extend the same `--remove-unrecorded` opt-in the unrecorded branch above
      // uses: a recorded-added delete is a DESTRUCTIVE op, so it must not be auto-applied
      // under --yes without the explicit opt-in. (A recorded-added that did NOT change is
      // suppressed in applyBaseline and never reaches here.)
      if (f.desired !== undefined && !opts.removeUnrecorded) {
        notRevertable.push({
          displayId,
          resourceType: f.resourceType,
          path: f.path,
          reason:
            'recorded added resource changed since record — reverting DELETES the whole resource; re-record if the change is right, or --remove-unrecorded to delete it',
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
    // A declared desired that carries GetTemplate `?`-masked non-ASCII text (judged
    // against the intact live value) must NOT be written back: the write would stamp
    // literal `?` runs over the live text wherever the template's non-ASCII literals
    // were masked. Only the declared tier is at risk — undeclared reverts write baseline
    // values recorded from the intact LIVE read. Two detections (see
    // hasGetTemplateMaskedLeaf / maskReadGapKeysOf):
    //   1. the finding's own desired/actual pair walks to a masked leaf, or
    //   2. WHOLE-ARRAY reverts only: a sibling GetTemplate-masked readGap sits under the
    //      same array path — the whole declared array being written contains that masked
    //      element even though this finding's own pair (whole array vs one edited leaf)
    //      cannot align to reveal it. Gated on wholeArrayRevert so a per-key writer that
    //      sends ONLY the edited attribute (ELB bags) is never false-blocked by a masked
    //      SIBLING it does not write.
    const maskedSiblingUnderPath = (): boolean => {
      if (maskGapKeys.size === 0) return false;
      for (const key of maskGapKeys) {
        const sep = key.indexOf('\0');
        if (key.slice(0, sep) !== f.logicalId) continue;
        const p = key.slice(sep + 1);
        if (p === f.path || p.startsWith(`${f.path}.`)) return true;
      }
      return false;
    };
    if (
      f.tier === 'declared' &&
      (hasGetTemplateMaskedLeaf(f.desired, f.actual) ||
        (f.wholeArrayRevert !== undefined && maskedSiblingUnderPath()))
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason:
          'declared value is non-ASCII-masked by GetTemplate ("?") — writing it back would corrupt the live text; redeploy from your CDK app instead',
      });
      continue;
    }
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
    // A resource type that can never be patched via Cloud Control UpdateResource — the apply
    // fails with a raw UnsupportedActionException — must bar the doomed cc-kind revert here
    // with a clear reason instead of emitting a patch that always fails. Two cases:
    //   (a) #908: the schema declares a `handlers` block but NO `update` handler (create/read/
    //       delete only — e.g. AWS::CloudFront::MonitoringSubscription) → `updatable === false`.
    //   (b) #1091: a CFn-legacy type read via SDK_OVERRIDES whose registry schema has NO
    //       `handlers` block AT ALL (ACM Certificate's shape) → `hasHandlers === false`. Here
    //       `updatable` is `undefined`, but that undefined means "handlers legitimately absent",
    //       NOT "schema unavailable" — so the #858 undefined-degrade skip (which leaves a
    //       genuinely schema-unavailable type UNBARRED, `hasHandlers` undefined) must not swallow
    //       it. The SDK_OVERRIDES guard confines this to types we KNOW are read via an SDK
    //       override (a pure CC-read type has a handlers block by construction). NOTE: most such
    //       types (ACM included) are ALSO caught by the broader SDK_OVERRIDES-not-in-
    //       CC_REVERTABLE_DESPITE_READ_OVERRIDE bar earlier in this loop; this is the narrower
    //       safety net for a handler-less type that IS on that allowlist (so it falls through the
    //       broader bar) yet can never take a CC UpdateResource.
    // EXEMPT (both cases): a type with a type-specific SDK writer (SDK_WRITERS / prop- / nested-
    // scoped) reverts via its own API, and a `delete`-kind out-of-band-added item already
    // `continue`d far above.
    const noUpdateHandler = schema?.updatable === false;
    const legacyNoHandlers = schema?.hasHandlers === false && !!SDK_OVERRIDES[f.resourceType];
    if (
      (noUpdateHandler || legacyNoHandlers) &&
      !SDK_WRITERS[f.resourceType] &&
      !propScoped &&
      !nestedScoped
    ) {
      notRevertable.push({
        displayId,
        resourceType: f.resourceType,
        path: f.path,
        reason: legacyNoHandlers
          ? 'CFn-legacy type has no update handler block — detect/record only'
          : 'type has no update handler — detect/record only',
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
      // #853: carry the raw live model onto the item so toPatchDocument can source an
      // index-bearing `test` op's value from the RAW domain (not canonicalized `op.prior`).
      item.liveRaw = live;
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

// Raw CFn / SAM templates legally declare integers/booleans as STRINGS
// (`"DelaySeconds": "300"`, `"Enabled": "true"` — CloudFormation coerces them to the
// resource's real type at deploy). Detection folds `"300"` vs `100` fine (the global
// stringly-equal guard), but a genuine drift's revert patch would write the STRING
// `"300"` into an integer-typed Cloud Control model property, which CC rejects with
// `ValidationException: expected type: Integer, found: String` — the drift is then
// permanently unrevertable for raw-CFn/SAM users (#725).
//
// The target property's real JSON type is exactly the type CloudFormation already
// coerced the live value to, so `live` (the finding's `actual`) IS the type oracle:
// coerce a string `desired` toward `live`'s type when `live` is a number or boolean.
// Only a CLEAN, LOSSLESS representation coerces (a finite numeric string for a number;
// `"true"`/`"false"` for a boolean) — anything else (`"abc"` for an integer, an empty
// string, whitespace) is left VERBATIM so a malformed declaration is never corrupted
// (fail safe = today's behavior). A `desired` that is genuinely a string coerces
// nothing, because when the property's real type is string the LIVE value is a string
// too, so neither branch below fires. This changes ONLY the value written on the revert
// path; detection/fold are untouched.
function coerceDeclaredScalar(desired: unknown, live: unknown): unknown {
  if (typeof desired !== 'string') return desired;
  if (typeof live === 'number') {
    // Number('') / Number('  ') are 0 (a silent, lossy coercion), so require the string
    // to actually contain a digit before trusting Number().
    const n = Number(desired);
    if (Number.isFinite(n) && desired.trim() !== '') return n;
    return desired;
  }
  if (typeof live === 'boolean') {
    if (desired === 'true') return true;
    if (desired === 'false') return false;
    return desired;
  }
  // bigint live is out of scope (CC models use JSON number/integer); string/object/etc.
  // targets are left verbatim.
  return desired;
}

function revertOp(f: Finding, recorded: BaselineFile['recorded']): PatchOp {
  const pointer = toPointer(f.path);
  if (f.tier === 'declared') {
    return {
      op: 'add',
      path: pointer,
      // Coerce a string-typed declared scalar toward the live value's real JSON type
      // (#725) — see coerceDeclaredScalar. A non-scalar `desired` (whole object/array
      // drift) passes straight through: coerceDeclaredScalar only touches a string.
      value: coerceDeclaredScalar(f.desired, f.actual),
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
function asTagList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
// Rewrite ONE whole-property tag `add`/`remove` op so the revert re-attaches the live
// `aws:*` managed tags it would otherwise strip. `pointer` is the op's own `/<Name>`
// pointer and `liveTags` the live value read under that name — so this works for `/Tags`
// AND every service-specific tag property (#862), MAP- or LIST-shaped.
function preserveManagedTags(op: PatchOp, pointer: string, liveTags: unknown): PatchOp {
  // MAP-shaped tags (key->value, e.g. SSM Parameter Tags, Cognito UserPoolTags): the
  // managed tags are aws:* KEYS. A whole-map revert that dropped them -> AWS rejects
  // ("aws: prefixed tag key names are not allowed for external use"). Preserve them.
  if (liveTags !== null && typeof liveTags === 'object' && !Array.isArray(liveTags)) {
    const managedMap = Object.fromEntries(
      Object.entries(liveTags).filter(([k]) => k.startsWith('aws:'))
    );
    if (Object.keys(managedMap).length === 0) return op;
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
      path: pointer,
      value: { ...userMap, ...managedMap },
      ...(op.prior !== undefined && { prior: op.prior }),
      human: `${op.human} (preserving aws:* managed tags)`,
    };
  }
  // LIST-shaped tags ({Key,Value}[]): the managed tags are aws:* ELEMENTS.
  const managed = awsManagedTags(liveTags);
  if (managed.length === 0) return op; // nothing managed to protect — leave the op as-is
  // user (non-managed) tags the revert wants to KEEP: an `add` keeps its value's tags, a
  // `remove` keeps none — either way, drop any aws:* entry from the value (it should never
  // carry one, but be defensive) and re-attach the live managed set.
  const userTags =
    op.op === 'add' ? asTagList(op.value).filter((t) => awsManagedTags([t]).length === 0) : [];
  return {
    op: 'add',
    path: pointer,
    value: [...userTags, ...managed],
    ...(op.prior !== undefined && { prior: op.prior }),
    human: `${op.human} (preserving aws:* managed tags)`,
  };
}
export function tagPreservingOps(
  ops: PatchOp[],
  liveRaw: Record<string, unknown> | undefined
): PatchOp[] {
  let changed = false;
  const out = ops.map((op) => {
    // Only a WHOLE-PROPERTY tag pointer `/<Name>` where Name is a known tag property is
    // rewritten. A NESTED single-key op (`/Tags/<key>`, `/UserPoolTags/<key>`) passes
    // through unchanged: it leaves every OTHER key — including the live aws:* managed ones
    // — in Cloud Control's read-modify-write model, so the provider never untags them.
    const name = /^\/([^/]+)$/.exec(op.path)?.[1];
    if (name === undefined || !TAG_PROPERTY_NAMES.has(name)) return op;
    const rewritten = preserveManagedTags(op, op.path, liveRaw?.[name]);
    if (rewritten !== op) changed = true;
    return rewritten;
  });
  // Preserve the by-reference "nothing to protect" contract callers rely on (return the
  // exact input array when no op was rewritten).
  return changed ? out : ops;
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

// Resolve the value at a concrete (wildcard-free) RFC6902 JSON pointer against a model,
// returning a sentinel when the pointer does not resolve — so a genuine `null` value is
// distinguished from an ABSENT one. Unlike expandPointer (which walks `*` wildcards and only
// descends OBJECT keys), this walks LITERAL numeric array-index segments too, as an
// index-bearing revert pointer (`/Rules/0/GroupSet`) requires. Each pointer segment is
// RFC6901-unescaped (`~1` -> `/`, `~0` -> `~`).
const POINTER_ABSENT = Symbol('pointer-absent');
function rawValueAtPointer(model: Record<string, unknown>, pointer: string): unknown {
  let node: unknown = model;
  for (const rawSeg of pointer.split('/').slice(1)) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(seg)) return POINTER_ABSENT;
      const idx = Number(seg);
      if (idx >= node.length) return POINTER_ABSENT;
      node = node[idx];
    } else if (node !== null && typeof node === 'object') {
      if (!Object.hasOwn(node as Record<string, unknown>, seg)) return POINTER_ABSENT;
      node = (node as Record<string, unknown>)[seg];
    } else {
      return POINTER_ABSENT;
    }
  }
  return node;
}

/**
 * Serialize a RevertItem's ops to an RFC6902 PatchDocument string for Cloud Control.
 *
 * #762: the Cloud Control path had no analogue of the SDK-writer guard (writers.ts
 * `desiredModel` re-reads + re-canonicalizes the live model so an indexed op lands on the
 * SAME element classify diffed). For an INDEX-BEARING pointer we emit a preceding RFC6902
 * `test` precondition asserting the addressed location still equals the value classify saw.
 * Cloud Control accepts standard RFC6902 and evaluates `test` atomically before the mutation,
 * so a shifted index makes it REJECT the whole patch instead of writing the wrong element —
 * fail-closed, the same intent as the writer-path re-read. Scalar non-indexed pointers carry
 * no aliasing risk (a named property is stable regardless of array order), so they get NO
 * `test` op — the patch stays minimal.
 *
 * #853: the `test` value must come from the RAW live model, NOT `op.prior` (= the finding's
 * canonicalized `f.actual`). Findings are built from `normalizeLiveModel` output — aws:* tags
 * stripped, readOnly/writeOnly paths stripped, `canonicalizeIdArraysDeep` sorts sg-/subnet-id
 * arrays, policy documents canonicalized, WAF `SearchString` base64-decoded. Cloud Control,
 * however, evaluates `test` against its RAW resource model. Whenever normalization transformed
 * the value at (or under) the tested pointer, asserting the canonical value against the raw
 * model fails though nothing raced (LIVE-confirmed on AWS::ECR::RegistryPolicy: the Action
 * array is canonicalize-SORTED vs the raw model's append-last order) → the whole patch is
 * rejected → revert of genuine drift always fails. So resolve the test value from the raw
 * live model passed by the apply path (the same UN-stripped `liveByLogical` model the
 * tag-preserving / empty-husk-strip paths already use). Fall back to `op.prior` only when the
 * raw model is unavailable (offline / no gather) or the pointer does not resolve against it
 * (then the index has genuinely shifted and the guard should still fire and fail-close).
 */
export function toPatchDocument(
  item: RevertItem,
  // The RAW live model for this resource. Defaults to the model carried on the item by
  // buildRevertPlan (from `opts.liveByLogical`), so the apply path calls `toPatchDocument(item)`
  // unchanged; an explicit arg is only for tests / callers without a built plan.
  liveRaw: Record<string, unknown> | undefined = item.liveRaw
): string {
  const doc: { op: string; path: string; value?: unknown }[] = [];
  for (const { op, path, value, prior } of item.ops) {
    // Guard only index-bearing pointers, and only when we know the value classify diffed
    // against (`prior` = f.actual). A `test` with an `undefined` value is meaningless
    // (RFC6902 has no "undefined"): skip it rather than assert an absent value.
    if (hasArrayIndexSegment(path) && prior !== undefined) {
      // Prefer the RAW value at the pointer; the canonicalized `prior` mismatches CC's raw
      // model whenever normalization transformed the subtree (#853). If the raw model is
      // absent, or the pointer doesn't resolve (index shifted away), keep `prior` so the
      // precondition still fails-closed rather than silently dropping the guard.
      const rawValue = liveRaw ? rawValueAtPointer(liveRaw, path) : POINTER_ABSENT;
      const testValue = rawValue === POINTER_ABSENT ? prior : rawValue;
      doc.push({ op: 'test', path, value: testValue });
    }
    doc.push(op === 'remove' ? { op, path } : { op, path, value });
  }
  return JSON.stringify(doc);
}

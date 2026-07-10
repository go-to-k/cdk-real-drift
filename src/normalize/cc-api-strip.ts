// Copied from cdkd src/analyzer/cc-api-strip.ts (pure, generic, no per-type switch).
// Strips AWS-managed / generated fields (timestamps, owner info, generated ids)
// from a CC API GetResource response at any depth before drift comparison.
const ALWAYS_STRIPPED = new Set<string>([
  'CreationDate',
  'CreationTime',
  'CreatedTime',
  'CreatedDate',
  'CreatedAt',
  'LastModifiedDate',
  'LastModifiedTime',
  'LastModified',
  'LastUpdatedTime',
  'LastUpdatedDate',
  'UpdatedAt',
  'OwnerId',
  'OwnerAccountId',
  'CreatedBy',
  'OwnerArn',
  'RevisionId',
  'LastUpdateStatus',
  'LastUpdateStatusReason',
  'LastUpdateStatusReasonCode',
  'StackId',
  'PhysicalResourceId',
  'LogicalResourceId',
]);

// USER-controlled free-form `Map<String,String>` properties: their KEYS are arbitrary
// user strings, so an `ALWAYS_STRIPPED` name appearing as a key here is the user's data,
// NOT an AWS-managed field — stripping it hides a real out-of-band change (a Lambda env
// var named `LastModified`, a Glue table Parameter named `OwnerId`, a user Tag named
// `CreatedBy`, …). Inside these maps we do NOT strip by name. (The genuine managed
// fields AWS adds at the TOP level — a function's own `LastModified`, a resource's
// `CreationDate` — are not under one of these keys, so they are still stripped; the few
// nested AWS-managed fields in STRUCTURED objects, e.g. StepFunctions
// `LoggingConfiguration.CreatedAt`, are also not under these keys, so they still strip.)
export const FREE_FORM_MAP_PARENTS = new Set([
  'Variables', // AWS::Lambda::Function Environment.Variables
  'Parameters', // AWS::Glue::Table/Database TableInput/DatabaseInput.Parameters
  'DefaultArguments', // AWS::Glue::Job
  'DockerLabels', // AWS::ECS::TaskDefinition container definitions
  'Labels', // generic label maps
  // Map-shaped tag properties (a user tag keyed like a managed field must not be
  // name-stripped) — `Tags` plus the service-specific map-shaped tag names (#862).
  'Tags',
  'UserPoolTags', // AWS::Cognito::UserPool
  'BackupPlanTags', // AWS::Backup::BackupPlan
  'BackupVaultTags', // AWS::Backup::BackupVault
  'RecoveryPointTags', // AWS::Backup::* recovery points
  // #1300: additional MAP-shaped primary tag properties from the CFn registry's
  // tagInformation.tagPropertyName metadata (keys are user strings, must not name-strip).
  'TieringConfigurationTags', // AWS::Backup::TieringConfiguration
  'TestAliasTags', // AWS::Bedrock::Agent / AWS::Bedrock::Flow
]);

// Tag-property names that carry the same semantics as `Tags` but live under a
// SERVICE-SPECIFIC name (#862) — both MAP-shaped ({k:v}: UserPoolTags, Backup*Tags) and
// LIST-shaped ({Key,Value}[]: IdentityPoolTags, BotTags, ...). AWS augments every one of
// them with managed `aws:*` tags, so the three sites that special-case `Tags` must treat
// them identically: the live `aws:*` strip (noise.stripAwsTagsDeep, so a first `check` of
// a tagged resource is clean), the free-form-map name-strip exemption above, and the
// revert managed-tag preservation (revert/plan.tagPreservingOps, so a tag revert never
// tries to untag `aws:cloudformation:*` and get rejected). Over-inclusion is SAFE at every
// site: each only acts on `aws:*`-prefixed data (never user intent) or a value AWS
// actually echoes as managed, so a non-tag property that happens to share one of these
// names is untouched.
export const TAG_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  'Tags',
  'UserPoolTags', // AWS::Cognito::UserPool (map)
  'BackupPlanTags', // AWS::Backup::BackupPlan (map)
  'BackupVaultTags', // AWS::Backup::BackupVault (map)
  'RecoveryPointTags', // AWS::Backup::* (map)
  'IdentityPoolTags', // AWS::Cognito::IdentityPool (list)
  'BotTags', // AWS::Lex::Bot (list)
  'ResourceTags', // AWS::CE::AnomalySubscription (list)
  'FileSystemTags', // AWS::EFS::FileSystem (list)
  'HostedZoneTags', // AWS::Route53::HostedZone (list)
  // #1300: additional primary/secondary tag property names sourced from the CFn
  // registry's tagInformation.tagPropertyName metadata (misses caused #862 first-run
  // map-key FPs and #952 revert drops of live aws:* managed tags).
  'TieringConfigurationTags', // AWS::Backup::TieringConfiguration (map)
  'FrameworkTags', // AWS::Backup::Framework (list)
  'ReportPlanTags', // AWS::Backup::ReportPlan (list)
  'PipelineTags', // AWS::DataPipeline::Pipeline (list)
  'AccessPointTags', // AWS::EFS::AccessPoint (list)
  'BotAliasTags', // AWS::Lex::BotAlias (list)
  'HealthCheckTags', // AWS::Route53::HealthCheck (list)
  'TestBotAliasTags', // AWS::Lex::Bot secondary (list)
  'TestAliasTags', // AWS::Bedrock::Agent / AWS::Bedrock::Flow secondary (map)
]);

// `freeFormSeed` seeds the strip walk's free-form flag at the ROOT of `awsProps`.
// Normally `false` (the top-level live model root is never itself free-form user data),
// but the BASELINE compare (#1267) passes a bare undeclared FRAGMENT whose root IS the
// content of a free-form map (a recorded `UserPoolTags` / `Environment.Variables` value):
// there is no ancestor key left in the fragment for `FREE_FORM_MAP_PARENTS` to match, so
// the caller — which still knows the entry's dotted PATH — seeds `true` to restore the
// same protection the full-model live walk gets from seeing the parent key. A user key
// colliding with a managed-field name (`CreatedBy`, `OwnerId`, an #1251 timestamp variant)
// then survives on both compare sides, so an out-of-band change to it still surfaces.
export function stripCcApiAwsManagedFields(
  awsProps: Record<string, unknown>,
  freeFormSeed = false
): Record<string, unknown> {
  return stripWalk(awsProps, freeFormSeed) as Record<string, unknown>;
}

// `freeForm` = this subtree lives under a free-form USER map (Lambda env Variables, Glue
// Parameters/DefaultArguments, DockerLabels, Labels, map-Tags) whose keys/values are user
// data — never name-strip there. Sticky DOWN the subtree (matching the sticky free-form
// flag in policy-canonical.ts, #182): the prior version recomputed the flag from the
// immediate parent only, so a NESTED object value under a free-form map lost the
// protection and a user key colliding with an ALWAYS_STRIPPED name (e.g. `CreatedBy`)
// would be stripped one level down. No real type nests objects under these parents today,
// so this is a defensive hardening to keep the two free-form guards consistent.
// #915: ALWAYS_STRIPPED is EXACT-match, so managed-timestamp NAME VARIANTS AWS uses on some
// types (CreateTime, UpdateTime, ModifiedAt, ModificationTime, LastUpdatedAt, CreationTimestamp,
// LastModifiedTimeStamp, …) leak through — and on a MODELED (non-readOnly) time prop that is a
// hidden #847-class moving value, that becomes a first-run FP which re-drifts on every read.
// Catch them with an ANCHORED, separator/case-normalized match: a curated managed-audit PREFIX
// immediately followed by a time SUFFIX. Anchored (`^…$`) so a user field that merely CONTAINS a
// time word is NEVER stripped — `StartTime`/`EndTime` (declarable), `ActiveDate`/`InactiveDate`,
// `ExpireTime`, `ValidFrom`, `UpdateTimeout` all fail the match. Errs toward UNDER-stripping (a
// managed variant not in the prefix set stays a harmless FP) rather than over-stripping (hiding
// real drift). Complements — does not replace — the exact ALWAYS_STRIPPED set + free-form guard.
const MANAGED_TIMESTAMP_NAME =
  /^(creation|created|create|lastmodified|lastupdated|lastupdate|modification|modified|updated|update)(date|time|timestamp|at)$/;
function isManagedTimestampName(key: string): boolean {
  return MANAGED_TIMESTAMP_NAME.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}
function stripWalk(value: unknown, freeForm: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const mapped = value.map((v) => stripWalk(v, freeForm));
    // A bare JSON `null` array ELEMENT is never a meaningful user value — it is a
    // service read artifact. S3, for one, echoes `TagFilters: [null]` inside every
    // prefix-scoped IntelligentTiering / Metrics config element that declares no
    // tag filter (#641), which then surfaces as a first-run undeclared FP on a
    // clean deploy. Drop null/undefined elements so the husk never surfaces; a REAL
    // out-of-band edit produces non-null objects, which still surface. Only outside
    // free-form USER maps (Lambda env Variables, Glue Parameters, …), where an array
    // value would be the user's own data and must be preserved verbatim. (This is
    // the safe complement to the #632 lesson: a null husk is droppable; a meaningful
    // scalar like `false` is not — and this drops only nulls, never scalars.)
    return freeForm ? mapped : mapped.filter((v) => v !== null && v !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      if (!freeForm && (ALWAYS_STRIPPED.has(k) || isManagedTimestampName(k))) continue;
      out[k] = stripWalk(child, freeForm || FREE_FORM_MAP_PARENTS.has(k));
    }
    return out;
  }
  return value;
}

export const STRIPPED_FIELDS_FOR_TEST: ReadonlySet<string> = ALWAYS_STRIPPED;

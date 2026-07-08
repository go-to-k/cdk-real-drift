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
  'Tags', // map-shaped Tags (a user tag keyed like a managed field)
]);

export function stripCcApiAwsManagedFields(
  awsProps: Record<string, unknown>
): Record<string, unknown> {
  return stripWalk(awsProps, false) as Record<string, unknown>;
}

// `freeForm` = this subtree lives under a free-form USER map (Lambda env Variables, Glue
// Parameters/DefaultArguments, DockerLabels, Labels, map-Tags) whose keys/values are user
// data — never name-strip there. Sticky DOWN the subtree (matching the sticky free-form
// flag in policy-canonical.ts, #182): the prior version recomputed the flag from the
// immediate parent only, so a NESTED object value under a free-form map lost the
// protection and a user key colliding with an ALWAYS_STRIPPED name (e.g. `CreatedBy`)
// would be stripped one level down. No real type nests objects under these parents today,
// so this is a defensive hardening to keep the two free-form guards consistent.
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
      if (!freeForm && ALWAYS_STRIPPED.has(k)) continue;
      out[k] = stripWalk(child, freeForm || FREE_FORM_MAP_PARENTS.has(k));
    }
    return out;
  }
  return value;
}

export const STRIPPED_FIELDS_FOR_TEST: ReadonlySet<string> = ALWAYS_STRIPPED;

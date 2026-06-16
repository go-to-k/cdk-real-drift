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
const FREE_FORM_MAP_PARENTS = new Set([
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
  return stripWalk(awsProps, undefined) as Record<string, unknown>;
}

function stripWalk(value: unknown, parentKey: string | undefined): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => stripWalk(v, parentKey));
  if (typeof value === 'object') {
    // when THIS object is the body of a free-form user map, its keys are user data —
    // never strip an ALWAYS_STRIPPED name here (it would hide a real change).
    const inFreeFormMap = parentKey !== undefined && FREE_FORM_MAP_PARENTS.has(parentKey);
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      if (!inFreeFormMap && ALWAYS_STRIPPED.has(k)) continue;
      out[k] = stripWalk(child, k);
    }
    return out;
  }
  return value;
}

export const STRIPPED_FIELDS_FOR_TEST: ReadonlySet<string> = ALWAYS_STRIPPED;

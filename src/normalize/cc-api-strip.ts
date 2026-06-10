// Copied from cdkd src/analyzer/cc-api-strip.ts (pure, generic, no per-type switch).
// Strips AWS-managed / generated fields (timestamps, owner info, generated ids)
// from a CC API GetResource response at any depth before drift comparison.
const ALWAYS_STRIPPED = new Set<string>([
  "CreationDate",
  "CreationTime",
  "CreatedTime",
  "CreatedDate",
  "CreatedAt",
  "LastModifiedDate",
  "LastModifiedTime",
  "LastModified",
  "LastUpdatedTime",
  "LastUpdatedDate",
  "UpdatedAt",
  "OwnerId",
  "OwnerAccountId",
  "CreatedBy",
  "OwnerArn",
  "RevisionId",
  "LastUpdateStatus",
  "LastUpdateStatusReason",
  "LastUpdateStatusReasonCode",
  "StackId",
  "PhysicalResourceId",
  "LogicalResourceId",
]);

export function stripCcApiAwsManagedFields(awsProps: Record<string, unknown>): Record<string, unknown> {
  return stripWalk(awsProps) as Record<string, unknown>;
}

function stripWalk(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripWalk);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      if (ALWAYS_STRIPPED.has(k)) continue;
      out[k] = stripWalk(child);
    }
    return out;
  }
  return value;
}

export const STRIPPED_FIELDS_FOR_TEST: ReadonlySet<string> = ALWAYS_STRIPPED;

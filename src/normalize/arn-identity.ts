// Name <-> ARN identity normalization. Many AWS fields accept a bare resource
// NAME on input but AWS stores + returns the full ARN (Lambda
// EventSourceMapping.FunctionName / Lambda Permission.FunctionName / ECS
// Service.Cluster, etc.). A positional string diff then reports false drift:
//   desired = "MyFn"   actual = "arn:aws:lambda:us-east-1:123:function:MyFn"
//
// Conservative + value-shape-based (NOT field-name-based, so it needs no per-type
// table): only treat the two as equal when `actual` is a well-formed ARN, `desired`
// is NOT an ARN, and the ARN's final component is EXACTLY `desired` (after the last
// ':' or '/'). A bare name in such a field resolves to that one resource in the
// stack's own account+region, whose ARN ends with `:<name>` — so this never hides a
// real drift to a DIFFERENT name (the suffix must match exactly).
//
// When the stack's accountId/region are supplied, ALSO require the ARN's region
// (index 3) and account (index 4) segments to match the stack's — a same-named
// resource in a DIFFERENT account/region is genuine drift, not a name<->ARN echo.
// Some ARN partitions leave region/account empty (S3: `arn:aws:s3:::bucket/name`);
// for those empty segments we skip the check and stay suffix-only.
export function isArnNameMatch(
  desired: unknown,
  actual: unknown,
  opts?: { accountId?: string; region?: string }
): boolean {
  if (typeof desired !== 'string' || typeof actual !== 'string') return false;
  if (desired.length === 0 || !actual.startsWith('arn:') || desired.startsWith('arn:'))
    return false;
  if (!(actual.endsWith(`:${desired}`) || actual.endsWith(`/${desired}`))) return false;
  // arn:partition:service:region:account:resource — segments 3 (region) + 4 (account)
  const seg = actual.split(':');
  const arnRegion = seg[3] ?? '';
  const arnAccount = seg[4] ?? '';
  if (opts?.region && arnRegion && arnRegion !== opts.region) return false;
  if (opts?.accountId && arnAccount && arnAccount !== opts.accountId) return false;
  return true;
}

// AWS-managed default KMS keys are declared by their well-known alias
// (`alias/aws/rds`, `alias/aws/secretsmanager`, ...) but AWS resolves + returns
// the concrete key ARN, which a string diff flags as drift. Treat a declared
// `alias/aws/*` against a live KMS key ARN as equal: a custom key would be
// declared as a custom alias or key id/ARN, never `alias/aws/<service>`, so this
// only collapses the managed-default case and never hides a real custom-key drift.
const KMS_KEY_ARN_RE = /^arn:aws[a-z-]*:kms:[^:]*:\d*:key\//;
export function isManagedKmsAliasMatch(desired: unknown, actual: unknown): boolean {
  return (
    typeof desired === 'string' &&
    typeof actual === 'string' &&
    desired.startsWith('alias/aws/') &&
    KMS_KEY_ARN_RE.test(actual)
  );
}

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
// the concrete key ARN, which a string diff flags as drift.
//
// When `aliasTargets` (alias name -> target key id, from KMS ListAliases) is
// provided AND the declared alias is in it, this does a STRICT comparison: the live
// key ARN must resolve to that same managed key, else it is reported as real drift —
// so a customer-managed key swapped in out of band (a security-relevant change the
// shape-only check would hide) IS caught. When the alias can't be resolved (no
// `aliasTargets`, or missing kms:ListAliases), it falls back to the conservative
// shape-based match (any `alias/aws/*` vs any key ARN = equal): biased toward noise,
// never a false positive.
const KMS_KEY_ARN_RE = /^arn:aws[a-z-]*:kms:[^:]*:\d*:key\//;
const keyIdOf = (s: string): string => s.slice(s.lastIndexOf('/') + 1);
export function isManagedKmsAliasMatch(
  desired: unknown,
  actual: unknown,
  aliasTargets?: Record<string, string>
): boolean {
  if (
    typeof desired !== 'string' ||
    typeof actual !== 'string' ||
    !desired.startsWith('alias/aws/') ||
    !KMS_KEY_ARN_RE.test(actual)
  )
    return false;
  const target = aliasTargets?.[desired];
  if (target) {
    // strict: suppress only when the live key IS the alias's managed key
    return keyIdOf(actual) === keyIdOf(target);
  }
  // unresolved alias → conservative shape-based suppression (today's behavior)
  return true;
}

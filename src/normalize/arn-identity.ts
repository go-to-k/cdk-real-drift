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
export function isArnNameMatch(desired: unknown, actual: unknown): boolean {
  if (typeof desired !== 'string' || typeof actual !== 'string') return false;
  if (desired.length === 0 || !actual.startsWith('arn:') || desired.startsWith('arn:'))
    return false;
  return actual.endsWith(`:${desired}`) || actual.endsWith(`/${desired}`);
}

// The construct path WITHIN its stack — the stack (and any enclosing CDK Stage) prefix
// removed. CDK forms the CloudFormation stack name by `-`-joining the leading construct-
// path segments (the enclosing Stage ids + the Stack construct id), while the construct
// path (`aws:cdk:path`) `/`-joins the same segments:
//
//   plain stack   MyStack/Api/Handler       stackName = MyStack      -> Api/Handler
//   CDK Stage     my-app/Rds/Db/PG    stackName = my-app-Rds -> Db/PG
//
// So strip the leading run of `/`-segments whose `-`-join equals the stack name. The
// report header already states the stack name, so repeating it on every finding line is
// noise — and dropping it makes the Stage form (a `/`-separated path beside a `-`-joined
// name) read consistently instead of looking like two different stack identifiers.
//
// Robust to the naming variants: a hyphen INSIDE a stack/stage id is fine (the whole
// segments are joined and compared to the actual stackName, never split); a stack whose id
// already bakes in the stage (`my-app-Rds/...`) strips as one segment; a nested
// Stage (`a/b/Stack/...` -> `a-b-Stack`) strips all of them. When nothing matches — e.g. an
// explicitly overridden `stackName` that no longer mirrors the construct ids — the path is
// returned UNCHANGED (a safe, self-contained fallback, never a wrong strip).
export function withinStackPath(constructPath: string, stackName: string): string {
  const segs = constructPath.split('/');
  // Largest k first so the most specific (full stage+stack) prefix wins; only one k can
  // match anyway, since stackName is exactly the `-`-join of those leading segments.
  for (let k = segs.length - 1; k >= 1; k--) {
    if (segs.slice(0, k).join('-') === stackName) return segs.slice(k).join('/');
  }
  return constructPath;
}

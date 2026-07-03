// Name <-> ARN identity normalization. Many AWS fields record a bare resource
// NAME on input but AWS stores + returns the full ARN (Lambda
// EventSourceMapping.FunctionName / Lambda Permission.FunctionName / ECS
// Service.Cluster, etc.). A positional string diff then reports false drift:
//   desired = "MyFn"   actual = "arn:aws:lambda:us-east-1:123:function:MyFn"
//
// Conservative + value-shape-based (NOT field-name-based, so it needs no per-type
// table): treat the two as equal when EXACTLY ONE side is a well-formed ARN, the
// other is a bare (non-ARN) name, and the name EQUALS the ARN's final component — its
// whole final colon-segment, OR the part after that segment's last '/' (the resource
// id of a `type/id` ARN). The match is on a COMPLETE component, never a partial path
// suffix, so a declared `a/b/c` never equals a live `arn:…:bucket/x/a/b/c` (a different
// object) — a real identity change is not hidden.
//
// BIDIRECTIONAL: the bare name may be on EITHER side. `desired=name, actual=ARN`
// occurs when AWS stores the full ARN for a name-recording input (Lambda
// EventSourceMapping.FunctionName, ECS Service.Cluster, ...); `desired=ARN,
// actual=name` occurs the other way (AWS::Lambda::Url.TargetFunctionArn: the template
// resolves Fn::GetAtt to the function ARN, but the live read returns the bare name).
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
  const dArn = desired.startsWith('arn:');
  const aArn = actual.startsWith('arn:');
  // exactly one side must be an ARN (both ARNs or neither = not a name<->ARN echo)
  if (dArn === aArn) return false;
  const arn = dArn ? desired : actual;
  const name = dArn ? actual : desired;
  return arnMatchesName(arn, name, opts);
}

function arnMatchesName(
  arn: string,
  name: string,
  opts?: { accountId?: string; region?: string }
): boolean {
  if (name.length === 0) return false;
  // Match the ARN's EXACT final component, NOT a raw suffix. The final colon-segment is
  // the resource portion (`myFn`, `role/myRole`, `bucket/a/b/c`); the name must equal
  // that whole portion OR the part after its last `/` (the resource id of a `type/id`
  // ARN). A bare `endsWith('/'+name)` matched a MULTI-segment path suffix — declared
  // `a/b/c` falsely equalled live `arn:…:bucket/x/a/b/c` (a DIFFERENT object), hiding a
  // real identity change. Equality on the final component never spans a `/` boundary, so
  // that FN is closed while every real name<->ARN echo (`myRole` vs `…:role/myRole`,
  // `myFn` vs `…:function:myFn`, `my-bucket` vs `arn:aws:s3:::my-bucket`) still matches.
  const afterColon = arn.slice(arn.lastIndexOf(':') + 1);
  const afterSlash = afterColon.includes('/')
    ? afterColon.slice(afterColon.lastIndexOf('/') + 1)
    : afterColon;
  // arn:partition:service:region:account:resource — segments 3 (region) + 4 (account)
  const seg = arn.split(':');
  // A resource id that itself carries a colon (a Lambda function ARN qualified by an
  // alias/version: `arn:…:function:NAME:QUALIFIER`) reassembles as segments 6.. — the
  // declared side is the bare `NAME:QUALIFIER`, which the last-colon-segment rule would
  // otherwise truncate to just `QUALIFIER`. Compare the whole colon-joined resource id too.
  const colonId = seg.length >= 7 ? seg.slice(6).join(':') : afterColon;
  if (name !== afterColon && name !== afterSlash && name !== colonId) return false;
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

// A CloudWatch Logs log-group ARN carries a trailing `:*` wildcard segment
// (`...:log-group:/my/group:*`) that scopes it to the group's log STREAMS. CDK's
// `logGroup.logGroupArn` emits the ARN WITH that `:*`, so a template references it
// that way — but several services store + return the SAME ARN with the `:*`
// stripped (observed: API Gateway `AWS::ApiGateway::Stage`
// AccessLogSetting.DestinationArn). A positional string diff then reports false
// drift on a fresh deploy with nothing changed:
//   desired = "arn:aws:logs:...:log-group:/aws/api-gateway/x:*"
//   actual  = "arn:aws:logs:...:log-group:/aws/api-gateway/x"
//
// Shape-based + value-only (NOT field-name-based, so no per-type table): suppress
// ONLY when BOTH sides are well-formed log-group ARNs that are byte-identical after
// dropping a single trailing `:*` from each. A different log group still differs
// after the strip, so this never hides a real repoint.
const LOG_GROUP_ARN_RE = /^arn:aws[a-z-]*:logs:[^:]*:\d*:log-group:/;
const stripLogGroupWildcard = (s: string): string => (s.endsWith(':*') ? s.slice(0, -2) : s);
export function isLogGroupArnWildcardMatch(desired: unknown, actual: unknown): boolean {
  if (
    typeof desired !== 'string' ||
    typeof actual !== 'string' ||
    !LOG_GROUP_ARN_RE.test(desired) ||
    !LOG_GROUP_ARN_RE.test(actual)
  )
    return false;
  return stripLogGroupWildcard(desired) === stripLogGroupWildcard(actual);
}

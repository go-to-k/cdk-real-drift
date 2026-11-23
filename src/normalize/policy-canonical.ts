// Canonicalize IAM-style policy documents so semantically-equal policies compare
// equal (cdkd lacks this — it raw-compares and tolerates false drift). Reused
// across every policy-bearing type (IAM, S3 BucketPolicy, SQS, SNS, KMS, ...).
//
// Normalizations: URL-decode + JSON.parse strings; fill default Version;
// scalar/array unify + sort for Action/Resource/Principal; sort statements.

import { FREE_FORM_MAP_PARENTS } from './cc-api-strip.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPolicyDoc(v: unknown): v is Record<string, unknown> {
  if (!isObj(v) || !('Statement' in v)) return false;
  // Require `Statement` to actually look like IAM statements — an array of (or a
  // single) object carrying an `Effect` (Allow/Deny) — NOT just any value under a key
  // literally named "Statement". Otherwise a user free-form field named `Statement`
  // (a string, number, or arbitrary object) would be force-canonicalized into policy
  // shape: a scalar wrapped into a one-element array, sibling keys reordered, two
  // different values equated (the cc-api-strip free-form-map mangling class). Mirrors
  // isPolicyStatementArray in classify.ts.
  const looksLikeStatement = (el: unknown): boolean => isObj(el) && 'Effect' in el;
  const s = v.Statement;
  return Array.isArray(s) ? s.every(looksLikeStatement) : looksLikeStatement(s);
}

/** Parse a (possibly URL-encoded) JSON string into a policy doc, or null. */
function parsePolicyString(s: string): Record<string, unknown> | null {
  for (const candidate of [s, safeDecode(s)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPolicyDoc(parsed)) return parsed;
    } catch {
      /* not JSON */
    }
  }
  return null;
}
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// scalar or array → sorted array (stable across single-vs-array CFn forms)
function toSortedArray(v: unknown): unknown {
  const arr = Array.isArray(v) ? [...v] : [v];
  return arr.map((x) => (isObj(x) ? sortKeys(x) : x)).sort(byJson);
}
function byJson(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

const ARRAYISH_KEYS = new Set(['Action', 'NotAction', 'Resource', 'NotResource']);

// An IAM `Condition` block is `{ <operator>: { <conditionKey>: <scalar|array> } }`.
// A condition key's value is an UNORDERED SET of strings the operator matches
// against, written either as a scalar (single value) or an array — IAM treats the
// two forms identically and may store/return either, in any element order. Without
// canonicalization a multi-value condition (`aws:SourceArn: [arnA, arnB]`) that AWS
// echoes reordered, or a single-value condition the template declares as a scalar
// while AWS stores it as a one-element array, both fire a false declared drift.
// Mirror the Action/Resource treatment: unify scalar↔array and sort each value set,
// on both sides, so a reordered-or-reshaped-but-equal condition compares equal while
// a genuine value change still differs after the sort. Operator/condition-key ORDER
// needs no sorting — deepEqual is key-order-insensitive.
function canonicalizeCondition(v: unknown): unknown {
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const op of Object.keys(v)) {
    const body = v[op];
    if (!isObj(body)) {
      out[op] = body;
      continue;
    }
    const inner: Record<string, unknown> = {};
    for (const key of Object.keys(body)) inner[key] = toSortedArray(body[key]);
    out[op] = inner;
  }
  return out;
}

function canonicalizeStatement(s: unknown): unknown {
  if (!isObj(s)) return s;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) {
    const v = s[k];
    // Every Sid is compared, a purely numeric one included (#1952). An earlier rule dropped
    // numeric Sids on the premise that AWS auto-assigns "1", "2", ... to a Sid-less
    // statement, but S3 (plain API and Cloud Control GetResource), SQS and SNS were measured
    // returning a Sid-less statement WITHOUT one, so the drop only hid a deliberate Sid edit.
    if (ARRAYISH_KEYS.has(k)) out[k] = toSortedArray(v);
    else if (k === 'Principal' || k === 'NotPrincipal') out[k] = canonicalizePrincipal(v);
    else if (k === 'Condition') out[k] = canonicalizeCondition(v);
    else out[k] = v;
  }
  return out;
}

// AWS's vended-log-delivery service (`delivery.logs.amazonaws.com`) APPENDS a statement
// to a destination S3 bucket's policy when log delivery is enabled (CloudFront standard
// logging v2, VPC flow logs, etc.) — Sid `AWSLogDeliveryWrite`/`AWSLogDeliveryAclCheck`.
// It is AWS-managed and never in the template, so it fires a false declared drift on the
// bucket policy's Statement array (an extra live-only statement). Recognized by the
// `AWSLogDelivery` Sid prefix AND the delivery-logs service principal AND a KNOWN-SAFE
// content shape (see below), it is subtracted before compare — same philosophy as
// stripping AWS-managed fields / aws:* tags. Symmetric: a user who declared the identical
// statement still compares equal (both sides drop it).
//
// #715 (security-relevant FALSE NEGATIVE): matching on ONLY the Sid prefix + principal is
// content-blind. A rogue statement that carries the `AWSLogDelivery*` Sid + delivery-logs
// principal but ARBITRARY grants (e.g. `Action: s3:*` to a foreign account) was silently
// subtracted on BOTH sides → the policy widening read CLEAN (invisible). So the subtraction
// is now equality-gated to the DOCUMENTED safe shape: `Effect` must be `Allow`, and every
// `Action` must be in the vended allow-set — the exact actions AWS grants the delivery-logs
// principal per DESTINATION type (S3: `s3:PutObject`/`s3:GetBucketAcl`; CloudWatch Logs:
// `logs:CreateLogStream`/`logs:PutLogEvents`; Firehose: `firehose:PutRecord`/`PutRecordBatch`).
// Anything broader — a wildcard or foreign Action (`s3:*`, `s3:DeleteObject`, `logs:*`, …) —
// is NOT subtracted, so it SURFACES as drift. Conservative by design: only the exact known-safe
// Action shapes are dropped; a deviation keeps the statement (no false negative). Genuine AWS
// statements (S3 bucket policy, Logs LogGroup resource policy, Firehose) still fold (no false
// positive). Resource / Condition EQUALITY is not gated — the destination ARN / owning
// account vary per deployment and are not knowable here — but the confused-deputy guard
// must be PRESENT (#1952): AWS vends these statements with an `aws:SourceAccount` /
// `aws:SourceArn` condition, so a statement whose condition was stripped out of band (any
// account's delivery can now write) no longer folds and surfaces.
//
// #1952: the subtraction is for a LIVE-ONLY statement. A statement the TEMPLATE declares
// (CDK adds `AWSLogDeliveryWrite` to a flow-log / vended-log bucket policy itself) is the
// user's, so the caller passes its Sid in `keepLogDeliverySids` and it is compared on both
// sides like any other statement — removing it, widening its Resource or dropping its
// condition out of band is drift. Actions per https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AWS-logs-and-resource-policy.html
const AWS_LOG_DELIVERY_ALLOWED_ACTIONS = new Set([
  's3:PutObject',
  's3:GetBucketAcl',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
  'firehose:PutRecord',
  'firehose:PutRecordBatch',
]);
function isAwsManagedLogDeliveryStatement(s: unknown): boolean {
  if (!isObj(s)) return false;
  const sid = s.Sid;
  if (typeof sid !== 'string' || !LOG_DELIVERY_SID_RE.test(sid)) return false;
  const principal = s.Principal;
  if (!isObj(principal)) return false;
  const svc = principal.Service;
  const services = Array.isArray(svc) ? svc : [svc];
  if (!services.includes('delivery.logs.amazonaws.com')) return false;
  // Content gate: only fold the DOCUMENTED safe shape. `Effect` must be `Allow` and every
  // `Action` must be in the vended allow-set — a broader/foreign grant surfaces (#715).
  if (s.Effect !== 'Allow') return false;
  const actionRaw = s.Action;
  const actions = Array.isArray(actionRaw) ? actionRaw : [actionRaw];
  if (actions.length === 0) return false;
  if (!actions.every((a) => typeof a === 'string' && AWS_LOG_DELIVERY_ALLOWED_ACTIONS.has(a)))
    return false;
  return hasSourceCondition(s.Condition);
}
// True when some operator of an IAM `Condition` block carries an `aws:SourceAccount` or
// `aws:SourceArn` key (condition keys are case-insensitive in IAM).
const SOURCE_CONDITION_KEYS = new Set(['aws:sourceaccount', 'aws:sourcearn']);
function hasSourceCondition(cond: unknown): boolean {
  if (!isObj(cond)) return false;
  return Object.values(cond).some(
    (body) =>
      isObj(body) && Object.keys(body).some((k) => SOURCE_CONDITION_KEYS.has(k.toLowerCase()))
  );
}

const LOG_DELIVERY_SID_RE = /^AWSLogDelivery/;

/** #1952: the Sids of every `AWSLogDelivery*` statement a (declared) value carries, at any
 *  depth and inside JSON-string policies too. Passed back as `keepLogDeliverySids` so a
 *  DECLARED log-delivery statement is compared instead of subtracted on both sides. */
export function collectLogDeliverySids(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    const p = parsePolicyString(v);
    if (p) collectLogDeliverySids(p, out);
  } else if (Array.isArray(v)) {
    for (const el of v) collectLogDeliverySids(el, out);
  } else if (isObj(v)) {
    if ('Effect' in v && typeof v.Sid === 'string' && LOG_DELIVERY_SID_RE.test(v.Sid))
      out.add(v.Sid);
    for (const val of Object.values(v)) collectLogDeliverySids(val, out);
  }
  return out;
}
function canonicalizePrincipal(v: unknown): unknown {
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const arr = (Array.isArray(v[k]) ? v[k] : [v[k]]) as unknown[];
      out[k] = arr.map(normalizeAccountPrincipal).sort(byJson);
    }
    return out;
  }
  return v; // "*" or a scalar
}

// IAM treats a bare account id and its root ARN as equivalent principals.
function normalizeAccountPrincipal(v: unknown): unknown {
  if (typeof v === 'string') {
    const m = /^arn:aws[a-z-]*:iam::(\d{12}):root$/.exec(v);
    if (m) return m[1];
  }
  return v;
}

// The IAM policy grammar's own top-level keys. A Version default is filled only into a
// value made of these alone: a resource MODEL that merely carries a `Statement` key
// (AWS::Events::EventBusPolicy) passes isPolicyDoc but is not a policy document.
const POLICY_GRAMMAR_KEYS = new Set(['Version', 'Id', 'Statement']);
// IAM: "If you do not include a Version element, the value defaults to 2008-10-17".
const IAM_DEFAULT_POLICY_VERSION = '2008-10-17';

export function canonicalizePolicy(
  doc: Record<string, unknown>,
  keepLogDeliverySids?: ReadonlySet<string>
): Record<string, unknown> {
  const rawStatements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  const statements = rawStatements.filter(
    (s) =>
      !isAwsManagedLogDeliveryStatement(s) ||
      keepLogDeliverySids?.has((s as Record<string, unknown>).Sid as string) === true
  );
  // Preserve ALL top-level keys (only `Statement` is rewritten). A policy document
  // may carry a doc-level `Id` (IAM/S3 policy grammar) or other top-level fields; a
  // prior whitelist of just `Statement`/`Version` DROPPED them, so two policies that
  // differ ONLY in `Id` (or any sibling key) canon-equalled — hiding an out-of-band
  // `Id`/sibling change (a false negative).
  const out: Record<string, unknown> = {
    ...doc,
    Statement: statements.map(canonicalizeStatement).sort(byJson),
  };
  // An absent Version IS "2008-10-17" to IAM, and the two versions differ in meaning
  // (policy variables such as `${aws:username}` are literal text under 2008-10-17). So fill
  // the default on both sides (#1952): a template omitting Version still equals a live
  // literal "2008-10-17", while a live "2012-10-17" against it is reported. Dropping the
  // key instead left an absent declared Version uncompared, hiding that change.
  if (doc.Version === undefined) {
    if (Object.keys(doc).every((k) => POLICY_GRAMMAR_KEYS.has(k)))
      out.Version = IAM_DEFAULT_POLICY_VERSION;
    else delete out.Version;
  }
  return out;
}

// A CloudFront legacy Origin Access Identity (OAI) grant can be written two
// equivalent ways in a resource policy principal:
//   declared (CDK `grantRead(oai)`): { CanonicalUser: <oai S3CanonicalUserId> }
//   live (S3 GetBucketPolicy / SNS / SQS read-back): AWS normalizes it to
//     { AWS: "arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity <oaiId>" }
// The two carry DIFFERENT tokens — the S3 canonical-user-id hex vs the OAI id —
// so a string diff fires a false declared drift on the bucket policy. We reconcile
// them by rewriting the `cloudfront:user` ARN form to the CanonicalUser form, using
// a resolved `oaiId -> S3CanonicalUserId` map (built in gather.ts from the stack's
// own OAI resources' live attributes — no extra AWS call). Applied to BOTH sides so
// either declaration style normalizes to the same canonical token; an empty/missing
// map is a no-op (the false positive simply remains rather than hiding real drift).
// An OAI id we cannot resolve is left as-is — never silently equated, so repointing
// a bucket policy to a DIFFERENT, unknown OAI is still reported.
const OAI_USER_ARN_RE =
  /^arn:aws[a-z-]*:iam::cloudfront:user\/CloudFront Origin Access Identity (.+)$/;

function rewriteOaiPrincipal(
  principal: Record<string, unknown>,
  oaiCanonicalIds: Record<string, string>
): Record<string, unknown> {
  const awsRaw = principal.AWS;
  if (awsRaw === undefined) return principal;
  const awsArr = Array.isArray(awsRaw) ? awsRaw : [awsRaw];
  const remainingAws: unknown[] = [];
  const resolvedCanonical: string[] = [];
  for (const entry of awsArr) {
    const oaiId = typeof entry === 'string' ? OAI_USER_ARN_RE.exec(entry)?.[1] : undefined;
    const canonical = oaiId ? oaiCanonicalIds[oaiId] : undefined;
    if (canonical) resolvedCanonical.push(canonical);
    else remainingAws.push(entry);
  }
  if (resolvedCanonical.length === 0) return principal; // nothing matched/resolved
  const out: Record<string, unknown> = { ...principal };
  if (remainingAws.length === 0) delete out.AWS;
  else out.AWS = remainingAws.length === 1 ? remainingAws[0] : remainingAws;
  const existing =
    out.CanonicalUser === undefined
      ? []
      : Array.isArray(out.CanonicalUser)
        ? out.CanonicalUser
        : [out.CanonicalUser];
  const merged = [...existing, ...resolvedCanonical];
  out.CanonicalUser = merged.length === 1 ? merged[0] : merged;
  return out;
}

/** Walk a value, rewriting every policy-statement `Principal`/`NotPrincipal` that
 *  grants a CloudFront OAI via its `cloudfront:user` ARN into the equivalent
 *  `CanonicalUser` form (see `rewriteOaiPrincipal`). No-op when the map is empty. */
export function rewriteOaiPrincipalsDeep(
  v: unknown,
  oaiCanonicalIds: Record<string, string>
): unknown {
  if (oaiCanonicalIds === undefined || Object.keys(oaiCanonicalIds).length === 0) return v;
  if (Array.isArray(v)) return v.map((x) => rewriteOaiPrincipalsDeep(x, oaiCanonicalIds));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if ((k === 'Principal' || k === 'NotPrincipal') && isObj(val)) {
        out[k] = rewriteOaiPrincipal(val, oaiCanonicalIds);
      } else {
        out[k] = rewriteOaiPrincipalsDeep(val, oaiCanonicalIds);
      }
    }
    return out;
  }
  return v;
}

// Canonicalize an embedded JSON string (e.g. ECR LifecyclePolicyText) so that
// pretty-printed vs minified vs key-reordered forms compare equal.
function canonicalizeJsonText(s: string): string {
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object') return JSON.stringify(sortDeep(parsed));
  } catch {
    /* not JSON */
  }
  return s;
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/**
 * Walk a value, replacing policy-document subtrees with their canonical form and
 * embedded JSON-text strings with a canonical (sorted, minified) form.
 */
export function normalizePoliciesDeep(
  v: unknown,
  keepLogDeliverySids?: ReadonlySet<string>
): unknown {
  return normWalk(v, false, keepLogDeliverySids);
}

// `freeForm` = this subtree lives under a free-form USER map (Lambda env Variables,
// Glue Parameters/DefaultArguments, DockerLabels, Labels, map-Tags). Those values are
// opaque user data AWS stores VERBATIM (Map<String,String>), so re-serializing /
// policy-canonicalizing a JSON-shaped value there would SUPPRESS a real out-of-band
// key-order / statement edit by the user (a false negative) — the same R69 protection
// cc-api-strip applies, extended to the policy/json-text canonicalizers that run after
// it. Sticky down the subtree (everything under a user map is user data).
function normWalk(v: unknown, freeForm: boolean, keep?: ReadonlySet<string>): unknown {
  if (typeof v === 'string') {
    if (freeForm) return v; // opaque user data — never canonicalize
    const p = parsePolicyString(v);
    if (p) return canonicalizePolicy(p, keep);
    return canonicalizeJsonText(v);
  }
  if (Array.isArray(v)) return v.map((el) => normWalk(el, freeForm, keep));
  if (!freeForm && isPolicyDoc(v)) return canonicalizePolicy(v, keep);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v))
      out[k] = normWalk(val, freeForm || FREE_FORM_MAP_PARENTS.has(k), keep);
    return out;
  }
  return v;
}

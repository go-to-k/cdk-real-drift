// Canonicalize IAM-style policy documents so semantically-equal policies compare
// equal (cdkd lacks this — it raw-compares and tolerates false drift). Reused
// across every policy-bearing type (IAM, S3 BucketPolicy, SQS, SNS, KMS, ...).
//
// Normalizations: URL-decode + JSON.parse strings; fill default Version;
// scalar/array unify + sort for Action/Resource/Principal; sort statements.

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
    if (ARRAYISH_KEYS.has(k)) out[k] = toSortedArray(v);
    else if (k === 'Principal' || k === 'NotPrincipal') out[k] = canonicalizePrincipal(v);
    else if (k === 'Condition') out[k] = canonicalizeCondition(v);
    else out[k] = v;
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

export function canonicalizePolicy(doc: Record<string, unknown>): Record<string, unknown> {
  const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  // Preserve ALL top-level keys (only `Statement` is rewritten). A policy document
  // may carry a doc-level `Id` (IAM/S3 policy grammar) or other top-level fields; a
  // prior whitelist of just `Statement`/`Version` DROPPED them, so two policies that
  // differ ONLY in `Id` (or any sibling key) canon-equalled — hiding an out-of-band
  // `Id`/sibling change (a false negative).
  const out: Record<string, unknown> = {
    ...doc,
    Statement: statements.map(canonicalizeStatement).sort(byJson),
  };
  // Keep Version only if present. Filling a default would create a false
  // declared-drift when the template omits Version but AWS stored a literal
  // (e.g. legacy "2008-10-17"); under subset comparison an absent declared
  // Version simply isn't compared, which is the correct outcome.
  if (doc.Version === undefined) delete out.Version;
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
export function normalizePoliciesDeep(v: unknown): unknown {
  if (typeof v === 'string') {
    const p = parsePolicyString(v);
    if (p) return canonicalizePolicy(p);
    return canonicalizeJsonText(v);
  }
  if (Array.isArray(v)) return v.map(normalizePoliciesDeep);
  if (isPolicyDoc(v)) return canonicalizePolicy(v);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = normalizePoliciesDeep(val);
    return out;
  }
  return v;
}

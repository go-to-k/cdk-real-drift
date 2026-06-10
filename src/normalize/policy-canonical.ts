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
  return isObj(v) && 'Statement' in v;
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

function canonicalizeStatement(s: unknown): unknown {
  if (!isObj(s)) return s;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) {
    const v = s[k];
    if (ARRAYISH_KEYS.has(k)) out[k] = toSortedArray(v);
    else if (k === 'Principal' || k === 'NotPrincipal') out[k] = canonicalizePrincipal(v);
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
  const out: Record<string, unknown> = { Statement: statements.map(canonicalizeStatement).sort(byJson) };
  // Keep Version only if present. Filling a default would create a false
  // declared-drift when the template omits Version but AWS stored a literal
  // (e.g. legacy "2008-10-17"); under subset comparison an absent declared
  // Version simply isn't compared, which is the correct outcome.
  if (doc.Version !== undefined) out.Version = doc.Version;
  return out;
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
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
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

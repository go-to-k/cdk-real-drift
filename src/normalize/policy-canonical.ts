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
    for (const k of Object.keys(v).sort()) out[k] = toSortedArray(v[k]);
    return out;
  }
  return v; // "*" or a scalar
}

export function canonicalizePolicy(doc: Record<string, unknown>): Record<string, unknown> {
  const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  return {
    Version: doc.Version ?? '2012-10-17',
    Statement: statements.map(canonicalizeStatement).sort(byJson),
  };
}

/** Walk a value, replacing every policy-document subtree with its canonical form. */
export function normalizePoliciesDeep(v: unknown): unknown {
  if (typeof v === 'string') {
    const p = parsePolicyString(v);
    return p ? canonicalizePolicy(p) : v;
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

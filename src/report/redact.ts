import { createHash } from 'node:crypto';

// #798 — report-layer redaction of secret-bearing live-readable property VALUES.
//
// Several CC/SDK-readable properties routinely carry live secrets (a Lambda env var
// holding an API token, a CodeBuild PLAINTEXT env var, an EC2 LaunchTemplate UserData
// bootstrap script, an ElasticBeanstalk `aws:elasticbeanstalk:application:environment`
// env var). cdkrd deliberately SURFACES a drift on these (hiding the finding would be a
// false negative — a rotated token IS drift), but printing the raw value leaks the live
// secret into a CI log (`cdkrd check --fail`) or the --json stream. This module masks the
// displayed VALUE only — the finding's tier / drift-ness / count are unchanged (detection
// preserved), the path/key name stays visible (it is not secret), and the plaintext never
// reaches the output.
//
// SCOPE: two halves, ONE curated table. (1) OUTPUT — the report renderers (text + --json)
// mask the displayed value. (2) PERSISTENCE — `record` writes a HASH SENTINEL (not the
// plaintext) into the git-committed baseline for the same secret-bearing paths, and
// `baselineValueMatches` re-hashes the live side to compare (change-detection survives; the
// plaintext never reaches `.cdkrd/baselines/*.json`). Both halves consult the same
// `REDACTED_VALUE_PATHS` table, so a path is secret in exactly one place. A non-secret
// property's value is NEVER masked or hashed — the table is curated to the secret-bearing
// paths and nothing else. Classification and folding are unchanged.

// The masked placeholder. Keeps the char length as a signal (a rotated 40-char token vs a
// blanked env var reads differently) AND appends a short sha256 prefix of the plaintext as a
// DISTINGUISHER (#1308): without it, a rotated same-length secret renders as a byte-identical
// `<redacted:N chars>` on both the desired/actual sides and across consecutive `--json` runs,
// so a human diff shows zero signal and a bot diffing two runs treats two DIFFERENT secrets as
// EQUAL (change-suppression on the machine channel). The hash is DETERMINISTIC and stable
// across runs (same plaintext → same placeholder), so consecutive `--json` runs compare
// correctly, and non-reversible for a high-entropy value. CAVEAT: for a LOW-entropy value (a
// short/guessable env var) the truncated hash is brute-forceable — it is a change-DISTINGUISHER,
// not a confidentiality guarantee; the plaintext (not the hash) is what must never be printed,
// which it never is. A non-string value (an object/array/number that slipped a matcher) masks
// to the length-less form (no stable byte string to hash).
export function maskPlaceholder(value: unknown): string {
  if (typeof value === 'string') {
    const sig = createHash('sha256').update(value).digest('hex').slice(0, 8);
    return `<redacted:${value.length} chars:${sig}>`;
  }
  return '<redacted>';
}

// A matcher decides, for one resourceType, whether a given finding path is secret-bearing
// and how to mask the value being rendered at that path. `pathRe` is tested against the
// finding path (which may carry an array index like `.0.` or a composite `[ns|name]`
// segment). `redact` returns the masked form of the value to DISPLAY (the caller has
// already done any comparison against the raw value, so masking the display never hides a
// finding).
interface RedactMatcher {
  pathRe: RegExp;
  redact: (value: unknown) => unknown;
}

// Mask the whole value (a scalar env-var value / UserData blob).
const maskWhole = (value: unknown): unknown => maskPlaceholder(value);

// Mask ONLY the `Value` sub-field of an object entry, keeping the identity fields
// (Namespace / OptionName / Name) visible. Used where the finding value is the WHOLE
// element object (EB OptionSettings composite-key subset, path `OptionSettings[ns|name]`)
// rather than a bare scalar. A non-object value falls back to whole-masking.
const maskEntryValueField = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'Value' in value) {
    return {
      ...(value as Record<string, unknown>),
      Value: maskPlaceholder((value as Record<string, unknown>).Value),
    };
  }
  return maskPlaceholder(value);
};

// Mask EVERY value of a free-form map (path is the whole map property, e.g. a Lambda
// `Environment.Variables` emitted whole because a key holds a `.`), keeping the KEY names
// visible. A non-object value falls back to whole-masking.
const maskMapValues = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = maskPlaceholder(v);
    return out;
  }
  return maskPlaceholder(value);
};

// Mask the secret sub-tree of a CONTAINER-level value whose finding path is the highest
// undeclared ANCESTOR of the secret (how classify emits the two most common leak scenarios,
// #1297). #1234's leaf/per-key matchers cannot fire on such a container path (e.g. a Lambda
// with no declared `Environment` surfaces ONE undeclared finding at path `Environment` whose
// value is the whole `{Variables:{…}}` object), so the plaintext prints raw in text and
// --json. These descend into the rendered value and mask at the remaining sub-path, keeping
// every non-secret key/identity field visible. A shape that does not match falls through
// unchanged (never whole-masks a container — that would hide non-secret siblings).

// Lambda `Environment` container: mask every value inside a nested `Variables` map, keeping
// the `Variables` key and each env-var KEY visible. Any sibling of `Variables` is untouched.
const maskEnvironmentContainer = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'Variables' in value) {
    return {
      ...(value as Record<string, unknown>),
      Variables: maskMapValues((value as Record<string, unknown>).Variables),
    };
  }
  return value;
};

// Mask the `Value` field of every element of an `[{Name,Value,Type}]` array (a CodeBuild
// `Environment.EnvironmentVariables` container emitted whole, or an array-delta element),
// keeping each `Name`/`Type` identity field visible. A non-array or a non-`{Value}` element
// is left unchanged.
const maskEnvVarArrayElement = (element: unknown): unknown => {
  if (element && typeof element === 'object' && !Array.isArray(element) && 'Value' in element) {
    return {
      ...(element as Record<string, unknown>),
      Value: maskPlaceholder((element as Record<string, unknown>).Value),
    };
  }
  return element;
};
// Mask a CodeBuild `Environment.EnvironmentVariables` value at its container path. The value
// is EITHER the whole `[{Name,Value,Type}]` array (whole-container finding) OR a SINGLE element
// (the text-report `formatArrayDelta` renders per-element via `redactValue` at the array path,
// #1297 scenario 3) — mask both shapes so neither leaks. A non-matching value falls through.
const maskEnvVarArray = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(maskEnvVarArrayElement) : maskEnvVarArrayElement(value);

// The curated table: resourceType -> secret-bearing path matchers. A finding whose
// resourceType + path matches has its DISPLAYED value masked; everything else prints in
// full (subject to the existing 200-char cap). The paths mirror the secret-bearing
// live-readable properties enumerated in #798.
const REDACTED_VALUE_PATHS: Record<string, RedactMatcher[]> = {
  // Lambda env vars: the per-key finding path is `Environment.Variables.<KEY>` (freeForm
  // per-key surfacing, classify.ts) — its scalar value is the secret. The whole map may
  // also be emitted at `Environment.Variables` when a key holds a `.` (drift-calculator
  // whole-map emit) — mask every value, keep the keys.
  'AWS::Lambda::Function': [
    { pathRe: /(^|\.)Environment\.Variables\./, redact: maskWhole },
    { pathRe: /(^|\.)Environment\.Variables$/, redact: maskMapValues },
    // #1297 container case: no declared `Environment` → ONE undeclared finding at path
    // `Environment` whose value is the whole `{Variables:{…}}` object. Descend + mask each
    // `Variables` value, keeping the keys. Ordered AFTER the leaf matchers so a leaf/whole-map
    // path (which also ends in `Variables`/`Variables.<k>`) takes its more-specific matcher.
    { pathRe: /(^|\.)Environment$/, redact: maskEnvironmentContainer },
  ],
  // CodeBuild PLAINTEXT env var: the reader projects `[{Name,Value,Type}]`, so a per-value
  // drift path is `Environment.EnvironmentVariables.<idx>.Value` (dot-indexed array).
  'AWS::CodeBuild::Project': [
    { pathRe: /(^|\.)Environment\.EnvironmentVariables\.\d+\.Value$/, redact: maskWhole },
    // #1297 container case: `Environment` declared without `EnvironmentVariables` → finding at
    // `Environment.EnvironmentVariables` whose value is the whole `[{Name,Value,Type}]` array.
    // Mask each element's `Value`, keeping `Name`/`Type`. Ordered AFTER the leaf matcher.
    { pathRe: /(^|\.)Environment\.EnvironmentVariables$/, redact: maskEnvVarArray },
  ],
  // EC2 LaunchTemplate UserData (base64 bootstrap script — may embed secrets). The
  // writeOnly strip is lifted for LaunchTemplateData so it is comparable; the UserData leaf
  // path is `LaunchTemplateData.UserData`.
  'AWS::EC2::LaunchTemplate': [
    { pathRe: /(^|\.)LaunchTemplateData\.UserData$/, redact: maskWhole },
  ],
  // ElasticBeanstalk env vars: the composite-key subset (Namespace|OptionName) emits a
  // finding at `OptionSettings[<ns>|<name>]` whose value is the WHOLE entry object. Only
  // the `aws:elasticbeanstalk:application:environment` namespace holds user env vars — mask
  // that entry's `Value` field, leaving the identity fields and every OTHER namespace's
  // option value visible (do NOT over-mask a non-secret InstanceType etc.).
  'AWS::ElasticBeanstalk::Environment': [
    {
      pathRe: /(^|\.)OptionSettings\[aws:elasticbeanstalk:application:environment\|/,
      redact: maskEntryValueField,
    },
  ],
};

// Return the masked form of a value if (resourceType, path) is a secret-bearing path in the
// table; otherwise return the value unchanged. The caller renders the returned value.
// Pure — no side effects, does not mutate the input.
export function redactValue(resourceType: string, path: string, value: unknown): unknown {
  const matchers = REDACTED_VALUE_PATHS[resourceType];
  if (!matchers) return value;
  // A baseline-side value at a secret path is already a HASH SENTINEL (record wrote a hash,
  // not the plaintext). It carries no secret, but render it as a plain `<redacted>` rather
  // than dumping the raw `{__cdkrdRedactedSha256__: …}` object into the report.
  if (isRedactedHashSentinel(value)) return '<redacted>';
  for (const m of matchers) {
    if (m.pathRe.test(path)) return m.redact(value);
  }
  return value;
}

// True if (resourceType, path) is a secret-bearing path in the table.
export function isRedactedPath(resourceType: string, path: string): boolean {
  const matchers = REDACTED_VALUE_PATHS[resourceType];
  return !!matchers && matchers.some((m) => m.pathRe.test(path));
}

// Redact a whole finding for the --json output: returns a shallow copy whose `desired` /
// `actual` (and any `arrayDelta` element values) are masked WHERE the finding's
// resourceType + path is secret-bearing, leaving every other field (tier, path, note,
// hint, …) intact so detection/counting is unchanged. For a per-KEY / per-element site
// where the leaf path extends the finding path (a whole free-form map, an identity-keyed
// array), the mask is applied at the finding-path level (maskMapValues / maskEntryValueField
// handle the sub-key masking), which covers the shapes the report renders.
//
// #1308: a masked copy additionally carries an out-of-band `redacted: true` marker so a
// `--json` consumer can tell a MASKED value from a literal live string — the mask is an
// in-band string (`<redacted:…>`) that a live property could in principle hold verbatim, so
// without the sibling flag a bot cannot distinguish "this value was withheld" from "the live
// value literally is that string". Non-secret findings are returned unchanged (no marker). The
// return type is widened (not the shared `Finding` type) so the flag is optional and only
// present on masked findings.
export function redactFinding<
  T extends {
    resourceType: string;
    path: string;
    desired?: unknown;
    actual?: unknown;
    arrayDelta?: unknown;
  },
>(f: T): T & { redacted?: true } {
  if (!isRedactedPath(f.resourceType, f.path)) return f;
  const out: T & { redacted?: true } = { ...f, redacted: true };
  if ('desired' in f && f.desired !== undefined)
    out.desired = redactValue(f.resourceType, f.path, f.desired);
  if ('actual' in f && f.actual !== undefined)
    out.actual = redactValue(f.resourceType, f.path, f.actual);
  // An identity-keyed array delta carries per-element values — mask those too so a recorded
  // secret array's --json element values are not leaked.
  if (f.arrayDelta && typeof f.arrayDelta === 'object') {
    out.arrayDelta = redactArrayDelta(f.resourceType, f.path, f.arrayDelta as ArrayDeltaShape);
  }
  return out;
}

// Minimal structural shape of ArrayDelta needed for masking (avoids importing the report's
// type here — this module stays dependency-light and testable in isolation).
interface ArrayDeltaShape {
  identityField: string;
  added: { id: string; value: unknown }[];
  removed: { id: string; value: unknown }[];
  changed: { id: string; recorded: unknown; actual: unknown }[];
}

function redactArrayDelta(resourceType: string, path: string, d: ArrayDeltaShape): ArrayDeltaShape {
  // Each delta entry's value is a SINGLE array ELEMENT, not the whole array — but `path` is the
  // ARRAY path (e.g. CodeBuild `Environment.EnvironmentVariables`), so before #1297 a
  // `redactValue` at the array path never masked a per-element `Value`. A secret-bearing
  // array-container matcher (`maskEnvVarArray`) now accepts a single element too, so a per-element
  // `redactValue` at the array path masks the element's `Value` — matching the text-report
  // `formatArrayDelta` path, which likewise redacts per-element at the array path.
  const mv = (v: unknown): unknown => redactValue(resourceType, path, v);
  return {
    identityField: d.identityField,
    added: d.added.map((a) => ({ id: a.id, value: mv(a.value) })),
    removed: d.removed.map((r) => ({ id: r.id, value: mv(r.value) })),
    changed: d.changed.map((c) => ({ id: c.id, recorded: mv(c.recorded), actual: mv(c.actual) })),
  };
}

// ── #798 persistence half — baseline HASH SENTINEL for secret-bearing recorded values ──
//
// The output half masks values in the REPORT; this half stops `record` from writing a live
// secret in PLAINTEXT into the git-committed baseline. When `buildRecorded` snapshots a
// finding whose (resourceType, path) `isRedactedPath`, it stores this SENTINEL — a single
// reserved key holding the SHA-256 of the (already-canonicalized) live value — instead of
// the raw value. `baselineValueMatches` recognizes the sentinel STRUCTURALLY (no path
// threading needed) and re-hashes the live side to compare: an unchanged secret hashes
// equal (record→check stays clean), a rotated secret hashes differently (re-surfaces as
// drift). The plaintext never reaches the baseline file or a diff of it.
//
// The caller hashes the value AFTER running the same `canonicalizeBaselineForCompare` the
// compare path uses, so record-then-check is reflexive; hashing here is order-stable via a
// deep key-sort (arrays keep their already-canonical order).

const REDACTION_HASH_KEY = '__cdkrdRedactedSha256__';

// Deterministic serialization for hashing: deep-sort object keys so two structurally-equal
// values hash identically regardless of key insertion order. Arrays keep order (the caller
// passes an already-canonicalized value whose unordered arrays are sorted). `undefined`
// (which `JSON.stringify` drops) hashes to a stable literal so it never collides with a
// real value.
function stableStringify(v: unknown): string {
  const sortDeep = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sortDeep);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort())
        out[k] = sortDeep((x as Record<string, unknown>)[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sortDeep(v)) ?? 'null';
}

// Build the hash sentinel for an ALREADY-CANONICALIZED value. The caller (buildRecorded)
// runs `canonicalizeBaselineForCompare` first so the stored hash matches the compare-time
// hash of the freshly-canonicalized live value.
function hashOfCanonical(canonicalValue: unknown): string {
  return 'sha256:' + createHash('sha256').update(stableStringify(canonicalValue)).digest('hex');
}

export function redactedHashSentinel(canonicalValue: unknown): Record<string, string> {
  return { [REDACTION_HASH_KEY]: hashOfCanonical(canonicalValue) };
}

// True if a baseline `value` is a redaction hash sentinel (a single reserved key mapping to
// a string). An older baseline holding a plaintext value is NOT a sentinel, so it keeps
// comparing via the normal deepEqual path — this change is backward-compatible.
export function isRedactedHashSentinel(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v as object).length === 1 &&
    typeof (v as Record<string, unknown>)[REDACTION_HASH_KEY] === 'string'
  );
}

// Reduce EITHER a hash sentinel OR an already-canonicalized value to its hash string, so a
// caller can compare two values whatever mix of {sentinel, raw-canonical} they are:
//   - both sentinels (re-record: two built recorded sets)        → compare stored hashes
//   - baseline sentinel vs raw live (check / applyBaseline)      → stored vs hash(live)
//   - old PLAINTEXT baseline vs new sentinel (first re-record)   → hash(plaintext) vs stored
// An unchanged secret yields the same hash in every case (record→check stays clean and the
// plaintext→sentinel migration does not churn); a rotated secret yields a different hash.
export function redactedHashOf(sentinelOrCanonical: unknown): string {
  return isRedactedHashSentinel(sentinelOrCanonical)
    ? (sentinelOrCanonical[REDACTION_HASH_KEY] ?? hashOfCanonical(sentinelOrCanonical))
    : hashOfCanonical(sentinelOrCanonical);
}

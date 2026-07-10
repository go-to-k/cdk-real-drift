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
// SCOPE: OUTPUT ONLY. This layer is consulted by the report renderers (text + --json). It
// does NOT change classification, folding, or what `record` writes to the baseline (that
// persistence half is a separate deferred lane, #798). A non-secret property's value is
// NEVER masked — the table is curated to the secret-bearing paths and nothing else.

// The masked placeholder. Keeps the char length as a signal (a rotated 40-char token vs a
// blanked env var reads differently) without revealing any plaintext. A non-string value
// (an object/array/number that slipped a matcher) masks to the length-less form.
export function maskPlaceholder(value: unknown): string {
  if (typeof value === 'string') return `<redacted:${value.length} chars>`;
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
  ],
  // CodeBuild PLAINTEXT env var: the reader projects `[{Name,Value,Type}]`, so a per-value
  // drift path is `Environment.EnvironmentVariables.<idx>.Value` (dot-indexed array).
  'AWS::CodeBuild::Project': [
    { pathRe: /(^|\.)Environment\.EnvironmentVariables\.\d+\.Value$/, redact: maskWhole },
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
export function redactFinding<
  T extends {
    resourceType: string;
    path: string;
    desired?: unknown;
    actual?: unknown;
    arrayDelta?: unknown;
  },
>(f: T): T {
  if (!isRedactedPath(f.resourceType, f.path)) return f;
  const out: T = { ...f };
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
  const mv = (v: unknown): unknown => redactValue(resourceType, path, v);
  return {
    identityField: d.identityField,
    added: d.added.map((a) => ({ id: a.id, value: mv(a.value) })),
    removed: d.removed.map((r) => ({ id: r.id, value: mv(r.value) })),
    changed: d.changed.map((c) => ({ id: c.id, recorded: mv(c.recorded), actual: mv(c.actual) })),
  };
}

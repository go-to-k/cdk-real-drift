// The shared value-canonicalization pipeline, used by BOTH the live/declared
// comparison in classify.ts AND the baseline-value comparison in baseline-file.ts.
// Keeping it in one place means a baseline recorded under an OLDER set of
// canonicalization rules still compares equal to the same live value under the
// CURRENT rules — so adding a normalizer (we have added four already) never makes a
// cdkrd version bump alone produce false drift on existing baselines.
//
// Order matches classify.ts's live side exactly: policy canonicalization first
// (Version / scalar-vs-array / statement order / account-id<->root-ARN), then tag
// lists (unordered set -> sorted by Key), then AWS-id arrays (unordered set ->
// sorted). It does NOT strip AWS-managed fields / aws:* tags / schema paths — those
// are live-only concerns the caller applies before this.
import { FREE_FORM_MAP_PARENTS, stripCcApiAwsManagedFields } from './cc-api-strip.js';
import {
  canonicalizeIdArraysDeep,
  canonicalizeIpv6CidrsDeep,
  canonicalizeTagListsDeep,
  normalizeWafByteMatchDeep,
  ORDER_SIGNIFICANT_ARRAY_KEYS,
  sortUnorderedObjectArray,
  stripAwsTagsDeep,
} from './noise.js';
import { normalizePoliciesDeep } from './policy-canonical.js';

// `resourceType` is optional: when given, identity-keyed object arrays the type marks
// as ORDER-significant (ORDER_SIGNIFICANT_ARRAY_KEYS — e.g. CodePipeline Stages/Actions)
// are NOT sorted, so both compare sides keep declared order and a finding's array index
// stays aligned with the raw live model the revert patches. classify passes the type
// for BOTH its live and declared sides; the type-less callers (baseline/writers) operate
// on undeclared snapshot values, which never carry an order-significant declared array.
export function canonicalizeForCompare(v: unknown, resourceType?: string): unknown {
  const orderSig = resourceType ? ORDER_SIGNIFICANT_ARRAY_KEYS[resourceType] : undefined;
  const base = canonicalizeIpv6CidrsDeep(
    canonicalizeIdArraysDeep(canonicalizeTagListsDeep(normalizePoliciesDeep(v), orderSig))
  );
  // A WAFv2 WebACL's ByteMatchStatement search patterns read back base64-encoded; fold both
  // sides to the plain SearchString the template declares so a clean rule is not false drift.
  return resourceType === 'AWS::WAFv2::WebACL' || resourceType === 'AWS::WAFv2::RuleGroup'
    ? normalizeWafByteMatchDeep(base)
    : base;
}

// Deeply apply the SAME canonical-JSON total order the live model reaches (classify's
// `sortUnorderedObjectArray` inside `sortUnorderedSetProps`) to every plain-object array,
// so both compare sides converge on one order even for an IDENTITY-LESS array
// `canonicalizeForCompare`'s identity-sort leaves in template order (#767). Only reorders
// (never merges/drops), and is applied to BOTH sides symmetrically, so it can never make
// two genuinely different values compare equal.
function sortObjectArraysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return sortUnorderedObjectArray(v.map(sortObjectArraysDeep));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = sortObjectArraysDeep(val);
    return out;
  }
  return v;
}

// #766: bring a RECORDED baseline value into the SAME canonical, noise-subtracted form the
// live value reaches before it becomes a finding's `f.actual`, so a baseline recorded under
// OLDER cdkrd rules re-canonicalizes to match today's freshly-stripped live value — a pure
// cdkrd UPGRADE (no template / AWS change) then never turns committed baselines into a
// "changed/removed since record" drift storm.
//
// `canonicalizeForCompare` alone covers only the pipeline INSIDE it (policies, tag lists,
// id arrays, WAF). The live value additionally passes, in classify's `normalizeLiveModel`,
// `stripCcApiAwsManagedFields` (drop AWS-managed timestamps / owner ids / revision ids),
// `stripAwsTagsDeep` (drop `aws:*` tags), the shared `canonicalizeForCompare`, then the
// readOnly/writeOnly schema strip + `sortUnorderedSetProps`. This mirrors the ones that are
// DEEP + ROOT-AGNOSTIC and so are safe to re-apply to a bare stored value fragment:
//   - `stripCcApiAwsManagedFields` — strips managed fields by NAME at any depth;
//   - `stripAwsTagsDeep` — strips `aws:*` tag elements by SHAPE at any depth;
//   - `canonicalizeForCompare(v, resourceType)` — the shared pipeline (now type-aware);
//   - `sortObjectArraysDeep` — the #767 canonical-JSON object-array order the live model
//     lands in via `sortUnorderedObjectArray`.
// All four are IDEMPOTENT, so a value recorded under TODAY's rules is unchanged (the
// predicate stays reflexive) and change detection is preserved (they only strip AWS-managed
// noise / reorder unordered sets, never merge or drop meaningful user values).
//
// NOT covered here (would need info a bare fragment lacks): the resourceType SCHEMA strip
// (`deepStripPaths(readOnly/writeOnly)`) and the scalar-set sort inside `sortUnorderedSetProps`
// are keyed on ROOT-anchored dotted paths + an ASYNC schema fetch, which this synchronous,
// model-root-less compare cannot supply. In practice those two already ran on both sides at
// record/read time via `normalizeLiveModel` (the recorded value came from a normalized model),
// so only a NEW schema readOnly/writeOnly path added in a later version is left uncovered.
//
// #1267: a stored baseline value is a bare FRAGMENT rooted AT its entry path — it has no
// ancestor keys left, so the strip walk (which normally engages free-form protection on
// SEEING a `FREE_FORM_MAP_PARENTS` parent key) never protects a fragment whose root IS the
// map content. A recorded undeclared free-form-map value (`UserPoolTags`,
// `Environment.Variables`, `Parameters`, `DockerLabels`, map `Tags`, …) containing a USER
// key that collides with a managed-field name (`CreatedBy`, `OwnerId`, an #1251 timestamp
// variant) then has that key stripped from BOTH compare sides, so an out-of-band change /
// add / remove of it can never surface (an FN #1205 introduced). The caller passes the
// entry's dotted `path`; if ANY of its segments is a free-form-map parent, the fragment
// content is user data, so seed the walk `freeForm=true` — mirroring the protection the
// full-model live walk gets from seeing that same parent key. `path` is optional: a
// path-less call stays the pre-#1267 behavior (seed false), keeping every non-free-form
// caller identical (so the #766/#1205 managed-field strip is preserved).
function seedFreeFormFromPath(path: string | undefined): boolean {
  if (!path) return false;
  const segments = path
    .replace(/\[([^\]]*)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);
  return segments.some((s) => FREE_FORM_MAP_PARENTS.has(s));
}

export function canonicalizeBaselineForCompare(
  v: unknown,
  resourceType?: string,
  path?: string
): unknown {
  const freeFormSeed = seedFreeFormFromPath(path);
  const stripped = stripAwsTagsDeep(
    stripCcApiAwsManagedFields(v as Record<string, unknown>, freeFormSeed)
  );
  return sortObjectArraysDeep(canonicalizeForCompare(stripped, resourceType));
}

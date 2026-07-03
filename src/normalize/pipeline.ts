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
import {
  canonicalizeIdArraysDeep,
  canonicalizeTagListsDeep,
  normalizeWafByteMatchDeep,
  ORDER_SIGNIFICANT_ARRAY_KEYS,
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
  const base = canonicalizeIdArraysDeep(
    canonicalizeTagListsDeep(normalizePoliciesDeep(v), orderSig)
  );
  // A WAFv2 WebACL's ByteMatchStatement search patterns read back base64-encoded; fold both
  // sides to the plain SearchString the template declares so a clean rule is not false drift.
  return resourceType === 'AWS::WAFv2::WebACL' ? normalizeWafByteMatchDeep(base) : base;
}

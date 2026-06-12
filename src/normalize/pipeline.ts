// The shared value-canonicalization pipeline, used by BOTH the live/declared
// comparison in classify.ts AND the baseline-value comparison in baseline-file.ts.
// Keeping it in one place means a baseline accepted under an OLDER set of
// canonicalization rules still compares equal to the same live value under the
// CURRENT rules — so adding a normalizer (we have added four already) never makes a
// cdkrd version bump alone produce false drift on existing baselines.
//
// Order matches classify.ts's live side exactly: policy canonicalization first
// (Version / scalar-vs-array / statement order / account-id<->root-ARN), then tag
// lists (unordered set -> sorted by Key), then AWS-id arrays (unordered set ->
// sorted). It does NOT strip AWS-managed fields / aws:* tags / schema paths — those
// are live-only concerns the caller applies before this.
import { canonicalizeIdArraysDeep, canonicalizeTagListsDeep } from './noise.js';
import { normalizePoliciesDeep } from './policy-canonical.js';

export function canonicalizeForCompare(v: unknown): unknown {
  return canonicalizeIdArraysDeep(canonicalizeTagListsDeep(normalizePoliciesDeep(v)));
}

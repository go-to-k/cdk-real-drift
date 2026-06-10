// NEW (cdkd lacks this — it raw-compares policy docs and tolerates false drift).
// Canonicalize IAM-style policy documents so semantically-equal policies compare
// equal. Reused across every policy-bearing type (IAM, S3 BucketPolicy, SQS, SNS,
// KMS, Lambda permission, ...).
//
// Normalizations:
//   - URL-decode if string (AWS returns encoded) then JSON.parse
//   - fill default Version "2012-10-17"
//   - singularize Action/Resource/Principal single-vs-array
//   - sort statements + sort keys for stable compare
export function canonicalizePolicy(input: unknown): unknown {
  // TODO(phase2)
  return input;
}

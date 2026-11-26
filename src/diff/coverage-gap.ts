// Which informational findings are COVERAGE GAPS — part of the stack cdkrd did not
// compare this run — as opposed to values that are unverifiable BY NATURE. `--strict`
// fails on the former (check.ts hasCoverageGap); the report's footer names them.
import type { Finding } from '../types.js';

/**
 * A readGap caused by a FAILED read rather than by the property's nature (#1970):
 *   - `readFailed` — a supplement / enrichment read was denied or errored (AccessDenied,
 *     kms:Decrypt on a Lambda's environment, a throttle), so the property was never read;
 *   - `compareOnly` — the value WAS read, but the comparison needs a lookup that was denied
 *     (an `alias/aws/*` KMS key with kms:ListAliases unavailable), so a swap to a
 *     customer-managed key would go unseen.
 * Both are fixable by granting a read permission, exactly like a `skipped` resource whose
 * read was denied. Write-only / not-echoed / GetTemplate-masked readGaps are NOT gaps: no
 * permission could make them readable.
 */
export function isCoverageReadGap(f: Finding): boolean {
  return f.tier === 'readGap' && (f.readFailed === true || f.compareOnly === true);
}

/** A gap an `.cdkrd/ignore.yaml` rule acknowledged (#1969): still listed, never `--strict`-failing. */
export function isAcknowledgedGap(f: Finding): boolean {
  return f.acknowledgedBy !== undefined;
}

// #727: under --pre-deploy the declared source is the LOCAL synth template, so a
// resource that exists there but has not been deployed yet legitimately has NO physical
// id. gather.ts emits `skipped: no physical id` for it (correct on the deployed path,
// where a missing physical id is a real anomaly — cf. #689), but under --pre-deploy this
// is EXPECTED, not a coverage gap: the next deploy will create it. This predicate matches
// ONLY that exact skip reason (note === 'no physical id'), so other skips — CC-unsupported,
// read errors — remain genuine coverage gaps even under --pre-deploy. Pure + exported.
export function isPendingCreationSkip(f: Finding): boolean {
  return f.tier === 'skipped' && f.note === 'no physical id';
}

// #724: a `Custom::*` / `AWS::CloudFormation::CustomResource` skip is a PERMANENT-by-nature
// coverage gap — a custom resource has no cloud-side model to read (router.ts short-circuits
// it), and nearly every real CDK app carries one (`Custom::S3AutoDeleteObjects`,
// `Custom::LogRetention`, `Custom::CDKBucketDeployment`). Failing `--strict` on it would exit
// 1 FOREVER on typical apps with nothing the user could record / ignore / fix — making the flag
// unusable exactly in the CI it is meant for. So it is INFORMATIONAL: still surfaced in the
// coverage warning + `skipped` footer (visibility preserved), but excluded from the `--strict`
// exit gate. An ACTIONABLE gap (a CC-unsupported type with no override, a read error / throttle
// / AccessDenied, an un-recursed nested stack) still fails `--strict`. Pure + exported.
export function isCustomResourceSkip(f: Finding): boolean {
  return (
    f.tier === 'skipped' &&
    (f.resourceType === 'AWS::CloudFormation::CustomResource' ||
      f.resourceType.startsWith('Custom::'))
  );
}

/**
 * The per-FINDING half of check.ts `hasCoverageGap` (the `--strict` gate): an
 * UNACKNOWLEDGED skipped resource (minus a `Custom::*` skip, #724, and — under
 * `--pre-deploy` — a pending-creation skip, #727) or failed-read readGap. The other half is
 * an un-recursed nested stack, which is a template RESOURCE, not a finding. The `ignore`
 * picker (#1976) offers exactly these, so every gap it lists is one whose acknowledgement
 * changes the `--strict` verdict, and none it omits is one `--strict` fails on.
 */
export function isStrictCoverageGapFinding(f: Finding, preDeploy = false): boolean {
  return (
    !isAcknowledgedGap(f) &&
    ((f.tier === 'skipped' &&
      !(preDeploy && isPendingCreationSkip(f)) &&
      !isCustomResourceSkip(f)) ||
      isCoverageReadGap(f))
  );
}

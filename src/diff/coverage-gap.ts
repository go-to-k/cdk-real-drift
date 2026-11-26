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

// Git-committed baseline file: .cdkrd/<stack>.<accountId>.<region>.json
// Stores the BLESSED undeclared property values (the only thing with no other
// source of truth — declared desired comes live from GetTemplate). `check`
// reports an undeclared finding only when it differs from / is absent in the
// baseline; with no baseline, every non-default undeclared value is shown.
//
// The accountId is in the FILENAME (not just a field) so the same stack name
// deployed to multiple accounts (the common `env: { account: PERSONAL || SHARED }`
// CDK pattern) gets one baseline file PER account — they never collide, and a
// personal-account run is not blocked by the shared-account baseline. The accountId
// is only known after a gather (DescribeStackResources), so `loadBaseline` must be
// called after the desired model is resolved.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deepEqual } from '../diff/drift-calculator.js';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import type { Finding } from '../types.js';

export interface AcceptedEntry {
  logicalId: string;
  resourceType: string;
  path: string;
  value: unknown;
}

export interface BaselineFile {
  schemaVersion: 1;
  stackName: string;
  region: string;
  accountId: string; // the AWS account the baseline was captured in (per-account guard)
  capturedAt: string;
  templateHash: string;
  accepted: AcceptedEntry[];
}

export function baselinePath(stackName: string, accountId: string, region: string): string {
  return `.cdkrd/${stackName}.${accountId}.${region}.json`;
}

export function hashTemplate(rawTemplate: string): string {
  return 'sha256:' + createHash('sha256').update(rawTemplate).digest('hex');
}

export async function loadBaseline(
  stackName: string,
  accountId: string,
  region: string
): Promise<BaselineFile | undefined> {
  try {
    return JSON.parse(
      await readFile(baselinePath(stackName, accountId, region), 'utf8')
    ) as BaselineFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Deterministic order for `accepted` entries: lexicographic by (logicalId, path).
 *  The single point where order is imposed — read/compare logic is order-independent,
 *  so this only affects the bytes on disk. Without it the entries inherit findings
 *  order (= template Resources order), so a pure CDK refactor that reorders construct
 *  definitions would produce a whole-file reordering diff on the next `accept` even
 *  though no accepted VALUE changed — breaking "the baseline PR diff = a review of the
 *  real state we accept". A non-locale comparator keeps it byte-stable across machines. */
function sortAccepted(accepted: AcceptedEntry[]): AcceptedEntry[] {
  return [...accepted].sort(
    (a, b) =>
      (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

export async function writeBaseline(b: BaselineFile): Promise<string> {
  const p = baselinePath(b.stackName, b.accountId, b.region);
  await mkdir(dirname(p), { recursive: true });
  // sort at the write point (not per entry-generation path) so every caller — accept,
  // selective accept, check's first-run offer — lands the same deterministic order.
  const stable: BaselineFile = { ...b, accepted: sortAccepted(b.accepted) };
  await writeFile(p, JSON.stringify(stable, null, 2) + '\n', 'utf8'); // pretty + stable for clean PR diffs
  return p;
}

/** Write a baseline for a stack from a check run's findings + raw template.
 *  Shared by `accept` and `check`'s first-run interactive offer. Pass `accepted`
 *  to bless a pre-filtered subset (selective accept); omit it to bless ALL
 *  undeclared findings (the default — same as `buildAccepted(findings)`). */
export async function blessStack(
  stackName: string,
  region: string,
  accountId: string,
  findings: Finding[],
  rawTemplate: string,
  accepted: AcceptedEntry[] = buildAccepted(findings)
): Promise<{ path: string; count: number }> {
  const path = await writeBaseline({
    schemaVersion: 1,
    stackName,
    region,
    accountId,
    capturedAt: new Date().toISOString(),
    templateHash: hashTemplate(rawTemplate),
    accepted,
  });
  return { path, count: accepted.length };
}

/**
 * Per-account guard (secondary defense). The baseline filename now embeds the
 * accountId, so a correctly-named file always matches; this guard catches a file
 * that was hand-copied or renamed to the wrong account's path (its `accountId`
 * field would then disagree with the filename it was loaded from). On a mismatch
 * this throws (caller surfaces exit 2). A pre-release file with no accountId field
 * only warns; the next `accept` stamps it.
 */
export function checkBaselineAccount(
  baseline: BaselineFile,
  currentAccountId: string,
  stackName: string,
  warn: (s: string) => void = console.error
): void {
  if (!baseline.accountId) {
    warn(
      `note: ${stackName}: baseline has no accountId (older file) — it will be stamped on the next \`cdkrd accept\`.`
    );
    return;
  }
  if (currentAccountId && baseline.accountId !== currentAccountId) {
    throw new Error(
      `baseline file for ${stackName} was captured in account ${baseline.accountId}, but the current account is ${currentAccountId} ` +
        '(the file was likely copied or renamed to the wrong account path). Baselines are per-account — ' +
        "run `cdkrd accept` to write this account's own baseline file, or restore the correct file from git."
    );
  }
}

/** Build the blessed-undeclared set from a check run's findings. */
export function buildAccepted(findings: Finding[]): AcceptedEntry[] {
  return findings
    .filter((f) => f.tier === 'undeclared')
    .map((f) => ({
      logicalId: f.logicalId,
      resourceType: f.resourceType,
      path: f.path,
      value: f.actual,
    }));
}

/** Stable key uniquely identifying an undeclared finding / accepted entry, for
 *  selective accept (the multiselect maps its picks to these keys). */
export function acceptedKey(e: { logicalId: string; path: string }): string {
  return `${e.logicalId}::${e.path}`;
}

/**
 * The single source of truth for "is this blessed value equal to the current
 * value?". `applyBaseline` (suppress vs surface) and `splitAcceptedByBaseline`
 * (unchanged vs changed) MUST share this exact predicate. The blessed value is
 * re-canonicalized through the CURRENT pipeline so a baseline written under older
 * normalization rules still matches today's canonical live value (R6) — the
 * `currentCanonicalValue` side is expected to be already canonical.
 */
export function blessedValueMatches(
  blessedValue: unknown,
  currentCanonicalValue: unknown
): boolean {
  return deepEqual(canonicalizeForCompare(blessedValue), currentCanonicalValue);
}

/**
 * Split a freshly-built accepted set against the existing baseline into the values
 * a human must decide on (`changed` = new path OR value differs) and the values
 * already blessed and unchanged (`unchanged` = same logicalId+path AND value
 * matches by `blessedValueMatches`). With no baseline EVERYTHING is `changed`
 * (the true first bless). Entries are matched against `entry.value` which comes
 * from `buildAccepted` (already canonical), so the predicate compares
 * canonical-vs-canonical, exactly like `applyBaseline`.
 */
export function splitAcceptedByBaseline(
  accepted: AcceptedEntry[],
  baseline: BaselineFile | undefined
): { unchanged: AcceptedEntry[]; changed: AcceptedEntry[] } {
  if (!baseline) return { unchanged: [], changed: [...accepted] };
  const unchanged: AcceptedEntry[] = [];
  const changed: AcceptedEntry[] = [];
  for (const entry of accepted) {
    const blessed = baseline.accepted.find(
      (a) => a.logicalId === entry.logicalId && a.path === entry.path
    );
    if (blessed && blessedValueMatches(blessed.value, entry.value)) unchanged.push(entry);
    else changed.push(entry);
  }
  return { unchanged, changed };
}

/** Selective accept: build the blessed set from only the findings whose key is in
 *  `selectedKeys`. Empty set -> []; all keys -> equals buildAccepted(findings). */
export function selectAccepted(findings: Finding[], selectedKeys: Set<string>): AcceptedEntry[] {
  return buildAccepted(findings).filter((e) => selectedKeys.has(acceptedKey(e)));
}

export interface ApplyBaselineOptions {
  // logicalId -> set of currently-declared top-level keys. A blessed entry whose
  // path is now DECLARED in the template is the recommended "promote undeclared
  // drift into code" workflow, NOT a removal — suppress the false removal finding.
  declaredByLogical?: Map<string, Set<string>>;
  warn?: (s: string) => void; // stderr note channel for the promotion case
}

const topSegment = (p: string): string => p.split('.')[0] ?? p;

/**
 * Reconcile undeclared findings against the blessed baseline:
 *  - an undeclared finding matching a blessed entry (same value) is suppressed;
 *  - a changed value / new path survives (= real drift);
 *  - a blessed entry with NO corresponding current undeclared value is reported as
 *    a removal (drift in the other direction — something blessed disappeared),
 *    UNLESS that path has since been DECLARED in the template (promotion to code —
 *    the workflow we recommend — which is noted, not flagged as drift).
 * Non-undeclared findings pass through untouched.
 */
export function applyBaseline(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  opts: ApplyBaselineOptions = {}
): Finding[] {
  if (!baseline) return findings;
  const blessed = baseline.accepted;
  const kept = findings.filter((f) => {
    if (f.tier !== 'undeclared') return true;
    // re-canonicalize the blessed value through the CURRENT pipeline before comparing
    // (f.actual is already canonical from classify): a baseline blessed under older
    // normalization rules still matches today's live, so a cdkrd version bump alone
    // never resurfaces a suppressed value as false drift.
    const match = blessed.find(
      (a) =>
        a.logicalId === f.logicalId && a.path === f.path && blessedValueMatches(a.value, f.actual)
    );
    return match === undefined;
  });
  // removed: blessed entries whose path is no longer present in any current undeclared finding
  const currentPaths = new Set(
    findings.filter((f) => f.tier === 'undeclared').map((f) => `${f.logicalId}.${f.path}`)
  );
  for (const a of blessed) {
    if (currentPaths.has(`${a.logicalId}.${a.path}`)) continue;
    // promoted into the template since accept → not a removal, just stale baseline
    if (opts.declaredByLogical?.get(a.logicalId)?.has(topSegment(a.path))) {
      opts.warn?.(
        `note: ${a.logicalId}.${a.path}: baseline entry is now declared in the template — re-run \`cdkrd accept\` to clean it up.`
      );
      continue;
    }
    kept.push({
      tier: 'undeclared',
      logicalId: a.logicalId,
      resourceType: a.resourceType,
      path: a.path,
      desired: a.value,
      actual: undefined,
      note: 'blessed value removed since accept',
    });
  }
  return kept;
}

/** logicalId -> set of declared top-level keys, for applyBaseline's promotion check. */
export function declaredKeysByLogical(
  resources: { logicalId: string; declared: Record<string, unknown> }[]
): Map<string, Set<string>> {
  return new Map(resources.map((r) => [r.logicalId, new Set(Object.keys(r.declared))]));
}

/**
 * Warn (never error) when the baseline was captured against a different template
 * version than the one now deployed — the blessed set may be stale. Skipped in
 * --pre-deploy mode (the synth template legitimately differs from the deployed one).
 */
export function warnTemplateHashDrift(
  baseline: BaselineFile,
  rawTemplate: string,
  stackName: string,
  warn: (s: string) => void = console.error
): void {
  if (!baseline.templateHash) return;
  if (baseline.templateHash !== hashTemplate(rawTemplate)) {
    warn(
      `note: ${stackName}: baseline was captured against a different template version — consider re-running \`cdkrd accept\`.`
    );
  }
}

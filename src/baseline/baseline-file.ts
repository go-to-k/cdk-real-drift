// Git-committed baseline file: .cdkrd/<stack>.<accountId>.<region>.json
// Stores the RECORDED undeclared property values (the only thing with no other
// source of truth — declared desired comes live from GetTemplate).
//
// Undeclared classification is PER ENTRY, not per file (R62): an undeclared
// finding with a matching entry is suppressed; with an entry whose value differs
// it is drift; with NO entry it is drift only if its resource is listed in
// `completeResources` (the record snapshot covered that whole resource, so the
// value APPEARED since) — otherwise the user never decided on it and it is
// UNRECORDED, not drift. File existence alone decides nothing: a cherry-pick
// record of one value must not flip the other hundred from unrecorded to drift.
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

export interface RecordedEntry {
  logicalId: string;
  resourceType: string;
  path: string;
  value: unknown;
}

export interface BaselineFile {
  schemaVersion: 1 | 2; // v1 files load fine; completeResources is absent (= nothing complete)
  stackName: string;
  region: string;
  accountId: string; // the AWS account the baseline was captured in (per-account guard)
  capturedAt: string;
  templateHash: string;
  recorded: RecordedEntry[];
  // v2 (R62): logicalIds whose undeclared snapshot was COMPLETE at record time —
  // every undeclared value the resource then had is in `recorded` (a resource with
  // zero undeclared values is trivially complete). An entry-less undeclared value
  // on a complete resource APPEARED since record = drift; on any other resource it
  // is UNRECORDED (never decided). Monotonic: once complete, a resource stays
  // complete (declining to record a new appeared value must not demote it back).
  completeResources?: string[];
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
  let raw: string;
  try {
    raw = await readFile(baselinePath(stackName, accountId, region), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  const parsed = JSON.parse(raw) as BaselineFile & { accepted?: RecordedEntry[] };
  // Back-compat: baselines written before `accept` was renamed to `record` stored the
  // entries under `accepted`; the field is now `recorded`. Read the old key so a
  // committed baseline keeps loading — the next `record` rewrites it under `recorded`.
  if (parsed.recorded === undefined && parsed.accepted !== undefined)
    parsed.recorded = parsed.accepted;
  delete parsed.accepted;
  return parsed;
}

/** Deterministic order for `recorded` entries: lexicographic by (logicalId, path).
 *  The single point where order is imposed — read/compare logic is order-independent,
 *  so this only affects the bytes on disk. Without it the entries inherit findings
 *  order (= template Resources order), so a pure CDK refactor that reorders construct
 *  definitions would produce a whole-file reordering diff on the next `record` even
 *  though no recorded VALUE changed — breaking "the baseline PR diff = a review of the
 *  real state we record". A non-locale comparator keeps it byte-stable across machines. */
function sortRecorded(recorded: RecordedEntry[]): RecordedEntry[] {
  return [...recorded].sort(
    (a, b) =>
      (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

export async function writeBaselineFile(b: BaselineFile): Promise<string> {
  const p = baselinePath(b.stackName, b.accountId, b.region);
  await mkdir(dirname(p), { recursive: true });
  // sort at the write point (not per entry-generation path) so every caller — record,
  // selective record, check's first-run offer — lands the same deterministic order.
  const stable: BaselineFile = {
    ...b,
    recorded: sortRecorded(b.recorded),
    ...(b.completeResources ? { completeResources: [...b.completeResources].sort() } : {}),
  };
  await writeFile(p, JSON.stringify(stable, null, 2) + '\n', 'utf8'); // pretty + stable for clean PR diffs
  return p;
}

/**
 * Which resources the record snapshot covered COMPLETELY (R62): every undeclared
 * finding of the resource is in `recorded` (zero undeclared findings = trivially
 * complete), and the resource was actually observed — a `skipped` (unread) or
 * `deleted` resource cannot be snapshot. Ignored-tier values do not block
 * completeness: they were visible and deliberately ruled out.
 * Monotonic via `previousComplete`: once complete, a resource stays complete
 * (declining to record an appeared-since-record value keeps it drift, instead of
 * demoting it back to unrecorded) — pruned to ids still in the template.
 */
export function computeCompleteResources(
  allLogicalIds: string[],
  findings: Finding[],
  recorded: RecordedEntry[],
  previousComplete: string[] = []
): string[] {
  const recordedKeys = new Set(recorded.map(recordedKey));
  const blocked = new Set<string>();
  for (const f of findings) {
    if (f.tier === 'skipped' || f.tier === 'deleted') blocked.add(f.logicalId);
    if (f.tier === 'undeclared' && !recordedKeys.has(recordedKey(f))) blocked.add(f.logicalId);
  }
  const all = new Set(allLogicalIds);
  const complete = new Set(previousComplete.filter((id) => all.has(id)));
  for (const id of allLogicalIds) if (!blocked.has(id)) complete.add(id);
  return [...complete].sort();
}

/** Write a baseline for a stack from a check run's findings + raw template.
 *  Shared by `record` and `check`'s first-run interactive offer. Pass `recorded`
 *  to record a pre-filtered subset (selective record); omit it to record ALL
 *  undeclared findings (the default — same as `buildRecorded(findings)`).
 *  `opts.allLogicalIds` (the template's full resource list) feeds the
 *  completeResources computation — without it, resources with no findings at all
 *  (read clean) would be invisible here; `opts.previous` keeps completeness
 *  monotonic across re-records. */
export async function writeBaseline(
  stackName: string,
  region: string,
  accountId: string,
  findings: Finding[],
  rawTemplate: string,
  recorded: RecordedEntry[] = buildRecorded(findings),
  opts: { allLogicalIds?: string[] | undefined; previous?: BaselineFile | undefined } = {}
): Promise<{ path: string; count: number }> {
  const allIds = opts.allLogicalIds ?? [
    ...new Set([...findings.map((f) => f.logicalId), ...recorded.map((a) => a.logicalId)]),
  ];
  const path = await writeBaselineFile({
    schemaVersion: 2,
    stackName,
    region,
    accountId,
    capturedAt: new Date().toISOString(),
    templateHash: hashTemplate(rawTemplate),
    recorded,
    completeResources: computeCompleteResources(
      allIds,
      findings,
      recorded,
      opts.previous?.completeResources ?? []
    ),
  });
  return { path, count: recorded.length };
}

/**
 * Per-account guard (secondary defense). The baseline filename now embeds the
 * accountId, so a correctly-named file always matches; this guard catches a file
 * that was hand-copied or renamed to the wrong account's path (its `accountId`
 * field would then disagree with the filename it was loaded from). On a mismatch
 * this throws (caller surfaces exit 2). A pre-release file with no accountId field
 * only warns; the next `record` stamps it.
 */
export function checkBaselineAccount(
  baseline: BaselineFile,
  currentAccountId: string,
  stackName: string,
  warn: (s: string) => void = console.error
): void {
  if (!baseline.accountId) {
    warn(
      `note: ${stackName}: baseline has no accountId (older file) — it will be stamped on the next \`cdkrd record\`.`
    );
    return;
  }
  if (currentAccountId && baseline.accountId !== currentAccountId) {
    throw new Error(
      `baseline file for ${stackName} was captured in account ${baseline.accountId}, but the current account is ${currentAccountId} ` +
        '(the file was likely copied or renamed to the wrong account path). Baselines are per-account — ' +
        "run `cdkrd record` to write this account's own baseline file, or restore the correct file from git."
    );
  }
}

/** Build the recorded-undeclared set from a check run's findings. */
export function buildRecorded(findings: Finding[]): RecordedEntry[] {
  return findings
    .filter((f) => f.tier === 'undeclared')
    .map((f) => ({
      logicalId: f.logicalId,
      resourceType: f.resourceType,
      path: f.path,
      value: f.actual,
    }));
}

/** Stable key uniquely identifying an undeclared finding / recorded entry, for
 *  selective record (the multiselect maps its picks to these keys). */
export function recordedKey(e: { logicalId: string; path: string }): string {
  return `${e.logicalId}::${e.path}`;
}

/**
 * The single source of truth for "is this baseline value equal to the current
 * value?". `applyBaseline` (suppress vs surface) and `splitRecordedByBaseline`
 * (unchanged vs changed) MUST share this exact predicate. The baseline value is
 * re-canonicalized through the CURRENT pipeline so a baseline written under older
 * normalization rules still matches today's canonical live value (R6) — the
 * `currentCanonicalValue` side is expected to be already canonical.
 */
export function baselineValueMatches(
  baselineValue: unknown,
  currentCanonicalValue: unknown
): boolean {
  return deepEqual(canonicalizeForCompare(baselineValue), currentCanonicalValue);
}

/**
 * Split a freshly-built recorded set against the existing baseline into the values
 * a human must decide on (`changed` = new path OR value differs) and the values
 * already recorded and unchanged (`unchanged` = same logicalId+path AND value
 * matches by `baselineValueMatches`). With no baseline EVERYTHING is `changed`
 * (the true first record). Entries are matched against `entry.value` which comes
 * from `buildRecorded` (already canonical), so the predicate compares
 * canonical-vs-canonical, exactly like `applyBaseline`.
 */
export function splitRecordedByBaseline(
  recorded: RecordedEntry[],
  baseline: BaselineFile | undefined
): { unchanged: RecordedEntry[]; changed: RecordedEntry[] } {
  if (!baseline) return { unchanged: [], changed: [...recorded] };
  const unchanged: RecordedEntry[] = [];
  const changed: RecordedEntry[] = [];
  for (const entry of recorded) {
    const baselineEntry = baseline.recorded.find(
      (a) => a.logicalId === entry.logicalId && a.path === entry.path
    );
    if (baselineEntry && baselineValueMatches(baselineEntry.value, entry.value))
      unchanged.push(entry);
    else changed.push(entry);
  }
  return { unchanged, changed };
}

/** Selective record: build the recorded set from only the findings whose key is in
 *  `selectedKeys`. Empty set -> []; all keys -> equals buildRecorded(findings). */
export function selectRecorded(findings: Finding[], selectedKeys: Set<string>): RecordedEntry[] {
  return buildRecorded(findings).filter((e) => selectedKeys.has(recordedKey(e)));
}

export interface ApplyBaselineOptions {
  // logicalId -> set of currently-declared top-level keys. An recorded entry whose
  // path is now DECLARED in the template is the recommended "promote undeclared
  // drift into code" workflow, NOT a removal — suppress the false removal finding.
  declaredByLogical?: Map<string, Set<string>>;
  warn?: (s: string) => void; // stderr note channel for the promotion case
}

const topSegment = (p: string): string => p.split('.')[0] ?? p;

/**
 * Reconcile undeclared findings against the recorded baseline (per ENTRY, R62):
 *  - an undeclared finding matching an recorded entry (same value) is suppressed;
 *  - an entry whose value changed survives as drift (the recorded contract was
 *    violated);
 *  - a finding with NO entry is drift only when its resource is snapshot-complete
 *    (`completeResources`) — the value APPEARED since record; on any other
 *    resource the user never decided on it, so it is tagged `unrecorded` (an
 *    inventory item, not drift — excluded from the verdict/exit downstream);
 *  - with NO baseline at all, every undeclared finding is unrecorded;
 *  - an recorded entry with NO corresponding current undeclared value is reported as
 *    a removal (drift in the other direction — something recorded disappeared),
 *    UNLESS that path has since been DECLARED in the template (promotion to code —
 *    the workflow we recommend — which is noted, not flagged as drift).
 * Non-undeclared findings pass through untouched.
 */
export function applyBaseline(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  opts: ApplyBaselineOptions = {}
): Finding[] {
  if (!baseline)
    return findings.map((f) => (f.tier === 'undeclared' ? { ...f, unrecorded: true } : f));
  const recorded = baseline.recorded;
  const complete = new Set(baseline.completeResources ?? []); // v1 file: nothing complete
  const kept: Finding[] = [];
  for (const f of findings) {
    // atDefault is reconciled alongside undeclared (R86): a value the user already
    // recorded is suppressed whichever tier it lands in today, so a baseline entry
    // whose live value is now classified at-default does NOT read as "removed".
    if (f.tier !== 'undeclared' && f.tier !== 'atDefault') {
      kept.push(f);
      continue;
    }
    const entry = recorded.find((a) => a.logicalId === f.logicalId && a.path === f.path);
    // re-canonicalize the baseline value through the CURRENT pipeline before comparing
    // (f.actual is already canonical from classify): a baseline recorded under older
    // normalization rules still matches today's live, so a cdkrd version bump alone
    // never resurfaces a suppressed value as false drift.
    if (entry && baselineValueMatches(entry.value, f.actual)) continue; // recorded, unchanged
    if (f.tier === 'atDefault') {
      // No (or a non-matching) recorded entry: the value still equals a known AWS
      // default (the equality gate proved it), so it stays folded inventory — never
      // drift, never unrecorded. A genuine change away from the default would not
      // match a default and would arrive as tier 'undeclared', handled below.
      kept.push(f);
      continue;
    }
    if (entry) {
      kept.push(f); // recorded value changed -> drift
    } else if (complete.has(f.logicalId)) {
      // the record snapshot covered this whole resource, so this value is new
      kept.push({
        ...f,
        note: f.note ? `${f.note}; appeared since record` : 'appeared since record',
      });
    } else {
      kept.push({ ...f, unrecorded: true }); // never decided -> not drift
    }
  }
  // removed: recorded entries whose path is no longer present in any current undeclared
  // OR at-default finding (R86: an recorded value reclassified at-default is still
  // present, not removed).
  const currentPaths = new Set(
    findings
      .filter((f) => f.tier === 'undeclared' || f.tier === 'atDefault')
      .map((f) => `${f.logicalId}.${f.path}`)
  );
  for (const a of recorded) {
    if (currentPaths.has(`${a.logicalId}.${a.path}`)) continue;
    // promoted into the template since record → not a removal, just stale baseline
    if (opts.declaredByLogical?.get(a.logicalId)?.has(topSegment(a.path))) {
      opts.warn?.(
        `note: ${a.logicalId}.${a.path}: baseline entry is now declared in the template — re-run \`cdkrd record\` to clean it up.`
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
      note: 'baseline value removed since record',
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
 * Warn (never error) when the baseline predates snapshot tracking (schema v1, no
 * `completeResources`): nothing is snapshot-complete, so values that appeared
 * since record read as UNRECORDED instead of drift until the next `record`
 * upgrades the file (R62).
 */
export function warnBaselineSchemaV1(
  baseline: BaselineFile,
  stackName: string,
  warn: (s: string) => void = console.error
): void {
  if (baseline.completeResources === undefined) {
    warn(
      `note: ${stackName}: baseline predates snapshot tracking — new out-of-band values read as unrecorded, not drift; re-run \`cdkrd record\` to upgrade it.`
    );
  }
}

/**
 * Warn (never error) when the baseline was captured against a different template
 * version than the one now deployed — the recorded set may be stale. Skipped in
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
      `note: ${stackName}: baseline was captured against a different template version — consider re-running \`cdkrd record\`.`
    );
  }
}

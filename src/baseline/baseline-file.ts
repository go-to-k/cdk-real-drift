// Git-committed baseline file: .cdkrd/<stack>.<accountId>.<region>.json
// Stores the ACCEPTED undeclared property values (the only thing with no other
// source of truth — declared desired comes live from GetTemplate).
//
// Undeclared classification is PER ENTRY, not per file (R62): an undeclared
// finding with a matching entry is suppressed; with an entry whose value differs
// it is drift; with NO entry it is drift only if its resource is listed in
// `completeResources` (the accept snapshot covered that whole resource, so the
// value APPEARED since) — otherwise the user never decided on it and it is
// UNRECORDED, not drift. File existence alone decides nothing: a cherry-pick
// accept of one value must not flip the other hundred from unrecorded to drift.
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
  schemaVersion: 1 | 2; // v1 files load fine; completeResources is absent (= nothing complete)
  stackName: string;
  region: string;
  accountId: string; // the AWS account the baseline was captured in (per-account guard)
  capturedAt: string;
  templateHash: string;
  accepted: AcceptedEntry[];
  // v2 (R62): logicalIds whose undeclared snapshot was COMPLETE at accept time —
  // every undeclared value the resource then had is in `accepted` (a resource with
  // zero undeclared values is trivially complete). An entry-less undeclared value
  // on a complete resource APPEARED since accept = drift; on any other resource it
  // is UNRECORDED (never decided). Monotonic: once complete, a resource stays
  // complete (declining to accept a new appeared value must not demote it back).
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

export async function writeBaselineFile(b: BaselineFile): Promise<string> {
  const p = baselinePath(b.stackName, b.accountId, b.region);
  await mkdir(dirname(p), { recursive: true });
  // sort at the write point (not per entry-generation path) so every caller — accept,
  // selective accept, check's first-run offer — lands the same deterministic order.
  const stable: BaselineFile = {
    ...b,
    accepted: sortAccepted(b.accepted),
    ...(b.completeResources ? { completeResources: [...b.completeResources].sort() } : {}),
  };
  await writeFile(p, JSON.stringify(stable, null, 2) + '\n', 'utf8'); // pretty + stable for clean PR diffs
  return p;
}

/**
 * Which resources the accept snapshot covered COMPLETELY (R62): every undeclared
 * finding of the resource is in `accepted` (zero undeclared findings = trivially
 * complete), and the resource was actually observed — a `skipped` (unread) or
 * `deleted` resource cannot be snapshot. Ignored-tier values do not block
 * completeness: they were visible and deliberately ruled out.
 * Monotonic via `previousComplete`: once complete, a resource stays complete
 * (declining to accept an appeared-since-accept value keeps it drift, instead of
 * demoting it back to unrecorded) — pruned to ids still in the template.
 */
export function computeCompleteResources(
  allLogicalIds: string[],
  findings: Finding[],
  accepted: AcceptedEntry[],
  previousComplete: string[] = []
): string[] {
  const acceptedKeys = new Set(accepted.map(acceptedKey));
  const blocked = new Set<string>();
  for (const f of findings) {
    if (f.tier === 'skipped' || f.tier === 'deleted') blocked.add(f.logicalId);
    if (f.tier === 'undeclared' && !acceptedKeys.has(acceptedKey(f))) blocked.add(f.logicalId);
  }
  const all = new Set(allLogicalIds);
  const complete = new Set(previousComplete.filter((id) => all.has(id)));
  for (const id of allLogicalIds) if (!blocked.has(id)) complete.add(id);
  return [...complete].sort();
}

/** Write a baseline for a stack from a check run's findings + raw template.
 *  Shared by `accept` and `check`'s first-run interactive offer. Pass `accepted`
 *  to record a pre-filtered subset (selective accept); omit it to accept ALL
 *  undeclared findings (the default — same as `buildAccepted(findings)`).
 *  `opts.allLogicalIds` (the template's full resource list) feeds the
 *  completeResources computation — without it, resources with no findings at all
 *  (read clean) would be invisible here; `opts.previous` keeps completeness
 *  monotonic across re-accepts. */
export async function writeBaseline(
  stackName: string,
  region: string,
  accountId: string,
  findings: Finding[],
  rawTemplate: string,
  accepted: AcceptedEntry[] = buildAccepted(findings),
  opts: { allLogicalIds?: string[] | undefined; previous?: BaselineFile | undefined } = {}
): Promise<{ path: string; count: number }> {
  const allIds = opts.allLogicalIds ?? [
    ...new Set([...findings.map((f) => f.logicalId), ...accepted.map((a) => a.logicalId)]),
  ];
  const path = await writeBaselineFile({
    schemaVersion: 2,
    stackName,
    region,
    accountId,
    capturedAt: new Date().toISOString(),
    templateHash: hashTemplate(rawTemplate),
    accepted,
    completeResources: computeCompleteResources(
      allIds,
      findings,
      accepted,
      opts.previous?.completeResources ?? []
    ),
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

/** Build the accepted-undeclared set from a check run's findings. */
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
 * The single source of truth for "is this baseline value equal to the current
 * value?". `applyBaseline` (suppress vs surface) and `splitAcceptedByBaseline`
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
 * Split a freshly-built accepted set against the existing baseline into the values
 * a human must decide on (`changed` = new path OR value differs) and the values
 * already accepted and unchanged (`unchanged` = same logicalId+path AND value
 * matches by `baselineValueMatches`). With no baseline EVERYTHING is `changed`
 * (the true first accept). Entries are matched against `entry.value` which comes
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
    const baselineEntry = baseline.accepted.find(
      (a) => a.logicalId === entry.logicalId && a.path === entry.path
    );
    if (baselineEntry && baselineValueMatches(baselineEntry.value, entry.value))
      unchanged.push(entry);
    else changed.push(entry);
  }
  return { unchanged, changed };
}

/** Selective accept: build the accepted set from only the findings whose key is in
 *  `selectedKeys`. Empty set -> []; all keys -> equals buildAccepted(findings). */
export function selectAccepted(findings: Finding[], selectedKeys: Set<string>): AcceptedEntry[] {
  return buildAccepted(findings).filter((e) => selectedKeys.has(acceptedKey(e)));
}

export interface ApplyBaselineOptions {
  // logicalId -> set of currently-declared top-level keys. An accepted entry whose
  // path is now DECLARED in the template is the recommended "promote undeclared
  // drift into code" workflow, NOT a removal — suppress the false removal finding.
  declaredByLogical?: Map<string, Set<string>>;
  warn?: (s: string) => void; // stderr note channel for the promotion case
}

const topSegment = (p: string): string => p.split('.')[0] ?? p;

/**
 * Reconcile undeclared findings against the accepted baseline (per ENTRY, R62):
 *  - an undeclared finding matching an accepted entry (same value) is suppressed;
 *  - an entry whose value changed survives as drift (the recorded contract was
 *    violated);
 *  - a finding with NO entry is drift only when its resource is snapshot-complete
 *    (`completeResources`) — the value APPEARED since accept; on any other
 *    resource the user never decided on it, so it is tagged `unrecorded` (an
 *    inventory item, not drift — excluded from the verdict/exit downstream);
 *  - with NO baseline at all, every undeclared finding is unrecorded;
 *  - an accepted entry with NO corresponding current undeclared value is reported as
 *    a removal (drift in the other direction — something accepted disappeared),
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
  const accepted = baseline.accepted;
  const complete = new Set(baseline.completeResources ?? []); // v1 file: nothing complete
  const kept: Finding[] = [];
  for (const f of findings) {
    // atDefault is reconciled alongside undeclared (R86): a value the user already
    // accepted is suppressed whichever tier it lands in today, so a baseline entry
    // whose live value is now classified at-default does NOT read as "removed".
    if (f.tier !== 'undeclared' && f.tier !== 'atDefault') {
      kept.push(f);
      continue;
    }
    const entry = accepted.find((a) => a.logicalId === f.logicalId && a.path === f.path);
    // re-canonicalize the baseline value through the CURRENT pipeline before comparing
    // (f.actual is already canonical from classify): a baseline accepted under older
    // normalization rules still matches today's live, so a cdkrd version bump alone
    // never resurfaces a suppressed value as false drift.
    if (entry && baselineValueMatches(entry.value, f.actual)) continue; // accepted, unchanged
    if (f.tier === 'atDefault') {
      // No (or a non-matching) accepted entry: the value still equals a known AWS
      // default (the equality gate proved it), so it stays folded inventory — never
      // drift, never unrecorded. A genuine change away from the default would not
      // match a default and would arrive as tier 'undeclared', handled below.
      kept.push(f);
      continue;
    }
    if (entry) {
      kept.push(f); // recorded value changed -> drift
    } else if (complete.has(f.logicalId)) {
      // the accept snapshot covered this whole resource, so this value is new
      kept.push({
        ...f,
        note: f.note ? `${f.note}; appeared since accept` : 'appeared since accept',
      });
    } else {
      kept.push({ ...f, unrecorded: true }); // never decided -> not drift
    }
  }
  // removed: accepted entries whose path is no longer present in any current undeclared
  // OR at-default finding (R86: an accepted value reclassified at-default is still
  // present, not removed).
  const currentPaths = new Set(
    findings
      .filter((f) => f.tier === 'undeclared' || f.tier === 'atDefault')
      .map((f) => `${f.logicalId}.${f.path}`)
  );
  for (const a of accepted) {
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
      note: 'baseline value removed since accept',
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
 * since accept read as UNRECORDED instead of drift until the next `accept`
 * upgrades the file (R62).
 */
export function warnBaselineSchemaV1(
  baseline: BaselineFile,
  stackName: string,
  warn: (s: string) => void = console.error
): void {
  if (baseline.completeResources === undefined) {
    warn(
      `note: ${stackName}: baseline predates snapshot tracking — new out-of-band values read as unrecorded, not drift; re-run \`cdkrd accept\` to upgrade it.`
    );
  }
}

/**
 * Warn (never error) when the baseline was captured against a different template
 * version than the one now deployed — the accepted set may be stale. Skipped in
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

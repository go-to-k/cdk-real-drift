// Git-committed baseline file: .cdkrd/baselines/<stack>.<accountId>.<region>.json
// Stores the RECORDED undeclared property values (the only thing with no other
// source of truth — declared desired comes live from GetTemplate).
//
// Lives under the `baselines/` subdirectory (not flat in `.cdkrd/`) so the machine-
// generated baselines stay visually separated from the hand-edited `.cdkrd/ignore.yaml`
// policy file — the directory name labels the role, and a multi-env tree of baselines
// stays tidy. JSON, not YAML (unlike ignore.yaml): a baseline is wholesale-rewritten
// machine data with no comment expectation, so deterministic JSON is the right fit.
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
import type { ArrayDelta, Finding } from '../types.js';

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
  // #674: logicalId -> the PHYSICAL id the recorded entries were snapshot against.
  // Additive & OPTIONAL — old committed baselines have none, and a resource whose
  // physical id was unknown at record time is simply absent. At `applyBaseline` time
  // an entry's recorded physical id (if present) is compared to the LIVE physical id:
  // when they DIFFER, the resource was REPLACED by a deploy (create-before-delete,
  // new physical id, fresh AWS defaults), so its recorded entries belong to the old,
  // deleted resource and must NOT surface as drift against the new one. Absent/unknown
  // recorded id -> fall back to today's behavior (never void).
  recordedPhysicalIds?: Record<string, string>;
}

export function baselinePath(stackName: string, accountId: string, region: string): string {
  return `.cdkrd/baselines/${stackName}.${accountId}.${region}.json`;
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
  const path = baselinePath(stackName, accountId, region);
  let parsed: BaselineFile & { accepted?: RecordedEntry[] };
  try {
    parsed = JSON.parse(raw) as BaselineFile & { accepted?: RecordedEntry[] };
  } catch {
    throw new Error(`baseline file ${path} is not valid JSON (corrupt or partially written)`);
  }
  if (parsed === null || typeof parsed !== 'object')
    throw new Error(`baseline file ${path} is malformed: root is not an object`);
  // Identity guard (load side): the baseline is keyed on three axes —
  // stackName.accountId.region — encoded in BOTH the filename and the stored fields.
  // The account axis is checked by the secondary `checkBaselineAccount` guard the
  // callers invoke; this checks the OTHER two, so a file whose stored `stackName`/
  // `region` disagrees with the path it was loaded from (hand-copied / renamed to the
  // wrong path, or a case-insensitive-FS collision like `MyStack` vs `mystack` sharing
  // one on-disk file) fails LOUDLY here (caller surfaces exit 2) instead of silently
  // applying another env's recorded state. Only checked when the field is PRESENT — an
  // older/partial file with no `stackName`/`region` is tolerated (the next `record`
  // stamps it), mirroring `checkBaselineAccount`'s leniency for a missing accountId.
  if (parsed.stackName && parsed.stackName !== stackName)
    throw new Error(
      `baseline file ${path} was captured for stack ${parsed.stackName}, but it was loaded as stack ${stackName} ` +
        '(the file was likely copied or renamed to the wrong path, or a case-insensitive filesystem collided two ' +
        "stacks onto one file). Baselines are per-stack — run `cdkrd record` to write this stack's own baseline " +
        'file, or restore the correct file from git.'
    );
  if (parsed.region && parsed.region !== region)
    throw new Error(
      `baseline file ${path} was captured in region ${parsed.region}, but the current region is ${region} ` +
        '(the file was likely copied or renamed to the wrong region path). Baselines are per-region — ' +
        "run `cdkrd record` to write this region's own baseline file, or restore the correct file from git."
    );
  // Back-compat: baselines written before `accept` was renamed to `record` stored the
  // entries under `accepted`; the field is now `recorded`. Read the old key so a
  // committed baseline keeps loading — the next `record` rewrites it under `recorded`.
  if (parsed.recorded === undefined && parsed.accepted !== undefined)
    parsed.recorded = parsed.accepted;
  delete parsed.accepted;
  // Fail-safe validation (a baseline is a git-committed, hand-editable, cross-version
  // artifact): a newer schemaVersion must error CLEARLY rather than be silently
  // mis-applied as v2, and a missing/non-array `recorded` must error here rather than
  // crash later with an opaque TypeError inside applyBaseline (`recorded.find`).
  // A PRESENT schemaVersion must be a number: reject a non-number (e.g. a string "3"
  // from a bad merge or hand-edit) rather than let it slip past the `> 2` future-guard
  // below (which only fires for numbers) and be silently mis-applied as ≤v2. An ABSENT
  // schemaVersion is tolerated (a very old file with no field reads as v1).
  if (parsed.schemaVersion !== undefined && typeof parsed.schemaVersion !== 'number')
    throw new Error(
      `baseline file ${path} has a non-numeric schemaVersion (${JSON.stringify(parsed.schemaVersion)}); it is malformed (corrupt or hand-edited)`
    );
  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > 2)
    throw new Error(
      `baseline file ${path} was written by a newer cdkrd (schemaVersion ${parsed.schemaVersion}); upgrade cdkrd`
    );
  if (!Array.isArray(parsed.recorded))
    throw new Error(`baseline file ${path} is malformed: \`recorded\` is missing or not an array`);
  // Element-level validation (#794): the container shape passing is not enough — a
  // baseline is git-committed, hand-editable, and merge-conflictable, so a malformed
  // ELEMENT (a `null` entry from a bad merge, a scalar where an array/map is expected)
  // must fail LOUDLY here (naming the file + the offending index/key) rather than crash
  // opaquely deep in applyBaseline (`recorded.find` on a null → "Cannot read properties
  // of null") or silently misbehave (`new Set("MyRes")` iterating string CHARACTERS,
  // turning completeness quietly off). Same loud-vs-silent principle the ignore.yaml
  // validation applies (config-file.ts validateIgnoreEntry).
  parsed.recorded.forEach((entry, i) => validateRecordedEntry(entry, i, path));
  validateCompleteResources(parsed.completeResources, path);
  validateRecordedPhysicalIds(parsed.recordedPhysicalIds, path);
  return parsed;
}

/**
 * #794: validate one `recorded` array element. Each must be a non-null object with a
 * string `logicalId` and a string `path` (the two fields the match logic reads —
 * `recorded.find(a => a.logicalId === … && a.path === …)`), plus a string `resourceType`
 * (used for the #793 type-mismatch guard and stamped onto the synthetic removed-since-record
 * finding). `value` is intentionally unconstrained (any JSON is a valid recorded value,
 * including `null`). Errors name the file + the offending index/key, mirroring the
 * ignore.yaml validation style.
 */
function validateRecordedEntry(entry: unknown, index: number, path: string): void {
  const at = `baseline file ${path}: \`recorded\`[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    throw new Error(`${at} must be an object { logicalId, resourceType, path, value }`);
  const obj = entry as Record<string, unknown>;
  for (const k of ['logicalId', 'resourceType', 'path'] as const)
    if (typeof obj[k] !== 'string')
      throw new Error(`${at}: "${k}" is required and must be a string`);
}

/**
 * #794: validate `completeResources` (optional; absent on v1 files). When present it must
 * be an array of strings — a bare string would have `new Set(...)` iterate its CHARACTERS
 * (silently mis-scoping completeness), and a number would crash with an opaque
 * "not iterable" later. Reject both loudly, naming the file + index.
 */
function validateCompleteResources(value: unknown, path: string): void {
  if (value === undefined) return;
  const at = `baseline file ${path}: \`completeResources\``;
  if (!Array.isArray(value)) throw new Error(`${at} must be an array of strings`);
  value.forEach((v, i) => {
    if (typeof v !== 'string') throw new Error(`${at}[${i}] must be a string`);
  });
}

/**
 * #794: validate `recordedPhysicalIds` (optional; #674). When present it must be a plain
 * object mapping string logicalId -> string physical id — `Object.entries` on a non-object
 * or a non-string value would otherwise mis-drive the #674 replacement check silently.
 * Reject non-object shapes and non-string values loudly, naming the file + key.
 */
function validateRecordedPhysicalIds(value: unknown, path: string): void {
  if (value === undefined) return;
  const at = `baseline file ${path}: \`recordedPhysicalIds\``;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${at} must be an object mapping logicalId to physical id`);
  for (const [key, v] of Object.entries(value as Record<string, unknown>))
    if (typeof v !== 'string') throw new Error(`${at}: "${key}" must map to a string`);
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

/** #674/#792: keep physical ids for logicalIds that either carry a recorded entry OR
 *  are snapshot-`complete` (a complete resource with ZERO undeclared entries has nothing
 *  in `recorded`, but its physical id must still be persisted so #674's replacement void
 *  fires for it — else an out-of-band REPLACEMENT of a zero-entry complete resource, whose
 *  fresh AWS defaults now "appear since record", surfaces as false drift). Sorted keys keep
 *  the JSON byte-stable; a logicalId neither recorded nor complete is dropped as dead. */
function sortedPhysicalIds(
  ids: Record<string, string>,
  recorded: RecordedEntry[],
  complete: string[]
): Record<string, string> {
  const persist = new Set([...recorded.map((e) => e.logicalId), ...complete]);
  const out: Record<string, string> = {};
  for (const key of Object.keys(ids).sort())
    if (persist.has(key) && ids[key] !== undefined) out[key] = ids[key];
  return out;
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
    // #674/#792: write the physical-id map with sorted keys so the JSON stays byte-stable
    // across machines (same clean-PR-diff goal as sortRecorded). Kept for logicalIds that
    // have a recorded entry OR are snapshot-`complete` — a complete resource with zero
    // undeclared entries must still carry its id so #674's replacement void can fire for
    // it (else an out-of-band REPLACEMENT surfaces as false "appeared since record").
    ...(b.recordedPhysicalIds
      ? {
          recordedPhysicalIds: sortedPhysicalIds(
            b.recordedPhysicalIds,
            b.recorded,
            b.completeResources ?? []
          ),
        }
      : {}),
  };
  await writeFile(p, JSON.stringify(stable, null, 2) + '\n', 'utf8'); // pretty + stable for clean PR diffs
  return p;
}

/**
 * Which resources the record snapshot covered COMPLETELY (R62): every undeclared
 * finding of the resource is in `recorded` (zero undeclared findings = trivially
 * complete), and the resource was actually observed — a `skipped` (unread),
 * `deleted`, or `readGap` (part of its live model UNREAD) resource cannot be
 * snapshot. A `readGap` finding means some of the resource's live state could not
 * be read this run (#795), so undeclared values hidden behind that gap were NOT
 * captured — the resource must not claim completeness, else a later cdkrd that
 * closes the read gap would surface those newly-visible values as false "appeared
 * since record" drift. Ignored-tier values do not block completeness: they were
 * visible and deliberately ruled out.
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
    if (f.tier === 'skipped' || f.tier === 'deleted' || f.tier === 'readGap')
      blocked.add(f.logicalId);
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
  opts: {
    allLogicalIds?: string[] | undefined;
    previous?: BaselineFile | undefined;
    // #674: logicalId -> live physical id at record time, so a later deploy that
    // REPLACES a resource (new physical id) can void its stale recorded entries.
    // Optional: an omitting caller keeps today's (physical-id-less) behavior.
    physicalIdByLogical?: Map<string, string> | undefined;
  } = {}
): Promise<{ path: string; count: number }> {
  const allIds = opts.allLogicalIds ?? [
    ...new Set([...findings.map((f) => f.logicalId), ...recorded.map((a) => a.logicalId)]),
  ];
  const completeResources = computeCompleteResources(
    allIds,
    findings,
    recorded,
    opts.previous?.completeResources ?? []
  );
  const path = await writeBaselineFile({
    schemaVersion: 2,
    stackName,
    region,
    accountId,
    capturedAt: new Date().toISOString(),
    templateHash: hashTemplate(rawTemplate),
    recorded,
    completeResources,
    // #674/#792: capture the physical id per recorded logicalId AND per zero-entry
    // `complete` resource. writeBaselineFile prunes this to recorded-or-complete ids.
    // Carry forward the previous baseline's map for ids this run did not resolve a
    // physical id for, so a re-record does not drop a previously-captured id (symmetric
    // with carryForwardUnreadable on `recorded`).
    ...buildRecordedPhysicalIds(
      recorded,
      completeResources,
      opts.physicalIdByLogical,
      opts.previous
    ),
  });
  return { path, count: recorded.length };
}

/**
 * #674/#792: build the `recordedPhysicalIds` map (logicalId -> physical id) for the
 * resources being written. Covers every RECORDED logicalId PLUS every snapshot-`complete`
 * resource — the latter so a resource recorded as complete but with ZERO undeclared
 * entries (nothing in `recorded`) still carries its physical id, letting #674's replacement
 * void fire for it too (an out-of-band REPLACEMENT of such a resource must not surface as
 * false "appeared since record" drift; see #792). Prefers the physical id resolved THIS
 * run; falls back to the previous baseline's stored id when this run did not resolve one
 * (a resource skipped / with no physical id must not lose its previously-captured id on
 * re-record — else a later replacement could not be detected). A resource with no known
 * physical id (this run or prior) is simply absent — today's behavior, never invented.
 * Returns `{}` (spread to nothing) when no id is known, so the field stays absent on
 * baselines with no physical ids at all.
 */
function buildRecordedPhysicalIds(
  recorded: RecordedEntry[],
  complete: string[],
  live: Map<string, string> | undefined,
  previous: BaselineFile | undefined
): { recordedPhysicalIds?: Record<string, string> } {
  const prior = previous?.recordedPhysicalIds ?? {};
  const out: Record<string, string> = {};
  for (const logicalId of new Set([...recorded.map((e) => e.logicalId), ...complete])) {
    const id = live?.get(logicalId) ?? prior[logicalId];
    if (id !== undefined) out[logicalId] = id;
  }
  return Object.keys(out).length > 0 ? { recordedPhysicalIds: out } : {};
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

/** Build the recorded set from a check run's findings: undeclared PROPERTIES plus
 *  out-of-band `added` RESOURCES (PR4 — `added` is the resource-granularity sibling of
 *  undeclared, so `record` snapshots its full live model and a later change to it
 *  surfaces as drift). An `added` entry has the synthesized child logicalId and an
 *  empty `path` (the whole resource is the value); `recordedKey` keeps it unique. */
export function buildRecorded(findings: Finding[]): RecordedEntry[] {
  return (
    findings
      .filter((f) => f.tier === 'undeclared' || f.tier === 'added')
      // PR4: never snapshot an `added` resource whose full model could not be read this
      // run (`modelReadFailed`) — its `actual` is only the identity snippet, and recording
      // that would false-flag "changed since record" on the next clean (full-model) read.
      .filter((f) => !f.modelReadFailed)
      .map((f) => ({
        logicalId: f.logicalId,
        resourceType: f.resourceType,
        path: f.path,
        value: f.actual,
      }))
  );
}

/** Stable key uniquely identifying an undeclared finding / recorded entry, for
 *  selective record (the multiselect maps its picks to these keys). */
export function recordedKey(e: { logicalId: string; path: string }): string {
  return `${e.logicalId}::${e.path}`;
}

/**
 * Carry forward previously-recorded entries for resources that this run could NOT
 * read, so a re-`record` does not silently SHRINK the (git-committed) baseline.
 *
 * `buildRecorded` only emits entries for resources observed this run (a `skipped`
 * resource produces no undeclared finding; an `added` resource whose full model
 * failed to read is filtered by `modelReadFailed`). Because `writeBaseline` writes
 * the `recorded` array as the COMPLETE new baseline (full replace, not a merge),
 * an entry absent from this run is permanently dropped — even when the resource was
 * merely unread, not actually changed-to-default. That loses a real recorded value:
 * a later out-of-band change to that property/resource can then no longer be
 * compared against it (it re-reads as unrecorded inventory, not "changed").
 *
 * The READ side (`applyBaseline`) already makes this exact distinction — it refuses
 * to surface a false "removed since record" for `skipped`/`modelReadFailed`
 * resources (unread ≠ gone). This is its symmetric WRITE-side guard: preserve the
 * existing baseline entries for resources unread this run (`skipped`, or a
 * `modelReadFailed` `added` finding). A resource read clean whose undeclared value
 * legitimately returned to its default is NOT unread, so it is correctly dropped; a
 * `deleted` resource is genuinely gone, so it is dropped too.
 */
export function carryForwardUnreadable(
  recorded: RecordedEntry[],
  existing: BaselineFile | undefined,
  findings: Finding[]
): RecordedEntry[] {
  const prior = existing?.recorded;
  if (!prior || prior.length === 0) return recorded;
  const unreadable = new Set(
    findings.filter((f) => f.tier === 'skipped' || f.modelReadFailed).map((f) => f.logicalId)
  );
  if (unreadable.size === 0) return recorded;
  const present = new Set(recorded.map(recordedKey));
  const preserved = prior.filter(
    (e) => unreadable.has(e.logicalId) && !present.has(recordedKey(e))
  );
  return preserved.length === 0 ? recorded : [...recorded, ...preserved];
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

// Identity fields for the ELEMENT-LEVEL DELTA display only (R128) — deliberately
// broader than classify's `IDENTITY_FIELDS` (which gate canonicalization + the R98
// nested descent and so must stay corpus-validated). This set is consulted ONLY to
// align a recorded-but-CHANGED undeclared array's elements for the report; the
// finding is already drift either way, so a wider identity set here can only sharpen
// what is shown and can NEVER create a false positive. `PolicyName` is the IAM Role
// inline-Policies case the user hit; `Name` covers the common named-element array.
const DELTA_IDENTITY_FIELDS = ['Key', 'Id', 'AttributeName', 'IndexName', 'PolicyName', 'Name'];

const isPlainObjectArray = (arr: unknown[]): boolean =>
  arr.length > 0 && arr.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));

// Pick the first identity field that EVERY element on BOTH sides carries as a string
// AND that is UNIQUE within each side. Uniqueness matters: a non-unique key would
// collapse two distinct elements into one map entry and mis-describe the delta — so
// fall back to the whole-array display (undefined) rather than show a wrong delta.
function deltaIdentityField(a: unknown[], b: unknown[]): string | undefined {
  if (!isPlainObjectArray(a) || !isPlainObjectArray(b)) return undefined;
  return DELTA_IDENTITY_FIELDS.find((f) => {
    const idsOf = (arr: unknown[]): string[] =>
      arr
        .map((x) => (x as Record<string, unknown>)[f])
        .filter((v): v is string => typeof v === 'string');
    const ia = idsOf(a);
    const ib = idsOf(b);
    return (
      ia.length === a.length &&
      ib.length === b.length &&
      new Set(ia).size === ia.length &&
      new Set(ib).size === ib.length
    );
  });
}

/**
 * Element-level delta of a recorded-but-CHANGED undeclared identity-keyed object
 * array (R128) — e.g. an IAM Role's inline Policies keyed by `PolicyName`. Computed
 * for the REPORT only: the finding stays at the whole-array path, so `record` still
 * snapshots the whole array (the property never un-records) and revert is unaffected;
 * this just says WHICH element(s) differ so the report shows the delta instead of
 * dumping the full array. Aligns by a unique identity field present on both sides,
 * then deep-compares matched pairs (so a same-name-but-changed-document element IS
 * still surfaced as `changed`, never missed). Returns undefined when the two sides
 * are not both unique-identity-keyed object arrays, or when nothing actually differs
 * after alignment (e.g. a pure reorder) — the caller then falls back to whole-array
 * display.
 */
export function identityArrayDelta(recordedVal: unknown, liveVal: unknown): ArrayDelta | undefined {
  if (!Array.isArray(recordedVal) || !Array.isArray(liveVal)) return undefined;
  const idf = deltaIdentityField(recordedVal, liveVal);
  if (!idf) return undefined;
  const byId = (arr: unknown[]): Map<string, unknown> =>
    new Map(arr.map((x) => [String((x as Record<string, unknown>)[idf]), x]));
  const rec = byId(recordedVal);
  const live = byId(liveVal);
  const added: ArrayDelta['added'] = [];
  const changed: ArrayDelta['changed'] = [];
  const removed: ArrayDelta['removed'] = [];
  for (const [id, v] of live) {
    if (!rec.has(id)) added.push({ id, value: v });
    else if (!deepEqual(rec.get(id), v)) changed.push({ id, recorded: rec.get(id), actual: v });
  }
  for (const [id, v] of rec) if (!live.has(id)) removed.push({ id, value: v });
  if (added.length === 0 && changed.length === 0 && removed.length === 0) return undefined;
  return { identityField: idf, added, removed, changed };
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
    // #793: match on resourceType too — a logicalId reused for a different type must not
    // match the old-type baseline entry (which would falsely read as "unchanged").
    const baselineEntry = baseline.recorded.find(
      (a) =>
        a.logicalId === entry.logicalId &&
        a.path === entry.path &&
        a.resourceType === entry.resourceType
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
  // logicalId -> CDK construct path. Used to restore constructPath onto the synthetic
  // "baseline value removed since record" finding so a constructPath-form ignore rule
  // matches it (a RecordedEntry carries no constructPath of its own).
  constructPathByLogical?: Map<string, string>;
  // logicalId -> live physical id. Used to restore physicalId onto the synthetic
  // "baseline value removed since record" finding. A RecordedEntry stores no physical
  // id, and unlike a LIVE finding (which classifyResource stamps with
  // resource.physicalId) this one is synthesized here — so without this it reaches
  // `revert` with NO physical id and buildRevertPlan rejects it ("no physical id"),
  // making a recorded value removed out of band UN-revertable (a real revert FN: the
  // value the user chose to keep disappeared, yet `revert` refuses to restore it).
  physicalIdByLogical?: Map<string, string>;
  // #675: the CURRENT template's full logical-id set. A recorded entry whose logicalId
  // is absent from it belongs to a resource legitimately REMOVED from the template (and
  // deleted by the deploy) — nothing drifted, so it must be folded into a nudge, never
  // surfaced as "baseline value removed since record". Optional: when omitted, the
  // absent-from-template check is skipped (today's behavior).
  allLogicalIds?: Set<string> | string[];
  warn?: (s: string) => void; // stderr note channel for the promotion case
}

// A recorded path is TOP-LEVEL when it is a bare template key — no nested descent
// separator (`.` object step or `[` array/identity step). `declaredByLogical` carries
// only top-level declared KEYS (Object.keys(declared)), so the "promoted into the
// template" test can only be answered for a top-level path: a nested path's top segment
// is ALWAYS a declared key by construction (collectNestedUndeclared descends only where
// the parent key is declared), so testing that segment would fold EVERY nested recorded
// value into `promotedStale` and never surface a legitimate removal (#749). A nested
// value is "promoted" only if its DECLARED parent now declares that exact nested value —
// which `declaredByLogical` cannot express — so a nested recorded path can never qualify
// here and must fall through to the "removed since record" drift.
const isTopLevelPath = (p: string): boolean => !p.includes('.') && !p.includes('[');

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
  // PR4 (option B): an out-of-band `added` resource is the resource-level sibling of an
  // undeclared property — with NO recorded intent (CFn template OR baseline) about it,
  // there is no contract to violate, so an UNRECORDED added resource is inventory, not
  // drift, exactly like an undeclared property with no entry. With no baseline at all,
  // every undeclared value AND every added resource is unrecorded.
  if (!baseline)
    return findings.map((f) =>
      f.tier === 'undeclared' || f.tier === 'added' ? { ...f, unrecorded: true } : f
    );
  const recorded = baseline.recorded;
  const complete = new Set(baseline.completeResources ?? []); // v1 file: nothing complete
  const kept: Finding[] = [];
  // #675: current template's logical-id set (optional). Recorded entries for a logicalId
  // NOT in it belong to a resource removed from the template — folded, never surfaced.
  const currentLogicalIds =
    opts.allLogicalIds === undefined
      ? undefined
      : Array.isArray(opts.allLogicalIds)
        ? new Set(opts.allLogicalIds)
        : opts.allLogicalIds;
  // #674: a logicalId whose RECORDED physical id differs from the LIVE physical id was
  // REPLACED by a deploy (create-before-delete → new physical id, fresh AWS defaults).
  // Its recorded entries belong to the old, deleted resource, so treat them all as VOID:
  // never a suppression MATCH, never surfaced as "changed since record" drift, never a
  // "removed since record" finding — just a folded nudge. Backward compatible: only void
  // when a recorded id EXISTS and DIFFERS from a KNOWN live id (absent recorded id = old
  // baseline; absent live id = unread this run → fall back to today's behavior).
  const recordedPhysIds = baseline.recordedPhysicalIds ?? {};
  const replacedLogical = new Set<string>();
  for (const [logicalId, recordedId] of Object.entries(recordedPhysIds)) {
    const liveId = opts.physicalIdByLogical?.get(logicalId);
    if (liveId !== undefined && liveId !== recordedId) replacedLogical.add(logicalId);
  }
  // #793: a logicalId's CURRENT resource type (from the live findings). A recorded entry
  // whose `resourceType` differs from the live type belongs to an OLD resource that was
  // deleted and re-added under the SAME logicalId as a DIFFERENT type (a template refactor
  // that recycled the id). Its recorded values are meaningless against the new type — worse,
  // the synthetic "removed since record" finding would pair the entry's OLD resourceType
  // with the new resource's LIVE physical id, so a revert would issue an op with the wrong
  // TypeName against the new resource. Treat such an entry as VOID, exactly like the #674
  // physical-id-mismatch path. Only voids when a live type is KNOWN and DIFFERS (an unread
  // logicalId has no finding here → no known live type → today's behavior, no void).
  const liveTypeByLogical = new Map<string, string>();
  for (const f of findings) if (f.resourceType) liveTypeByLogical.set(f.logicalId, f.resourceType);
  // #793: an entry is type-VOID when a live type is known for its logicalId and disagrees
  // with the entry's recorded type. Used both at the match sites (so it never suppresses /
  // surfaces against the wrong type) and in the removed-since-record loop below.
  const isTypeVoid = (e: { logicalId: string; resourceType: string }): boolean => {
    const liveType = liveTypeByLogical.get(e.logicalId);
    return liveType !== undefined && liveType !== e.resourceType;
  };
  // #793: match a recorded entry to a finding on logicalId + path AND resource type, so a
  // logicalId reused for a different type never matches old-type entries.
  const entryMatches = (a: RecordedEntry, f: Finding): boolean =>
    a.logicalId === f.logicalId && a.path === f.path && a.resourceType === f.resourceType;
  for (const f of findings) {
    // PR4: reconcile `added` against the baseline as a full mirror of undeclared — but on
    // the WHOLE resource (path ''), not a property. A matching entry whose value is equal
    // is suppressed; a recorded value that CHANGED stays `added` drift with a "changed
    // since record" note + the baseline value on `desired` (so the report shows it); a
    // resource with NO entry is unrecorded inventory (not drift). The completeResources /
    // "appeared since record" mechanism is undeclared-only (it is keyed per template
    // resource, and an added child has a synthesized id that never enters allLogicalIds),
    // so a newly-appeared added resource is simply unrecorded until the user records it.
    if (f.tier === 'added') {
      const entry = recorded.find((a) => entryMatches(a, f));
      // PR4: the full model could not be read this run — `actual` is only the identity
      // snippet, so we CANNOT decide changed-vs-unchanged. Never false-flag "changed": a
      // recorded resource is suppressed (it was verified before; re-checked next clean
      // run, like a transiently-skipped resource), an un-recorded one stays Not-Recorded.
      if (f.modelReadFailed) {
        if (entry) continue;
        kept.push({ ...f, unrecorded: true });
        continue;
      }
      if (entry && baselineValueMatches(entry.value, f.actual)) continue; // recorded, unchanged
      if (entry) {
        kept.push({
          ...f,
          desired: canonicalizeForCompare(entry.value),
          note: f.note ? `${f.note}; changed since record` : 'changed since record',
        });
        continue;
      }
      kept.push({ ...f, unrecorded: true }); // never decided -> not drift
      continue;
    }
    // atDefault AND generated are reconciled alongside undeclared (R86): a value the
    // user already recorded is suppressed whichever undeclared-side tier it lands in
    // today, so a baseline entry whose live value is now classified at-default OR
    // generated does NOT read as "removed" — and a recorded value CHANGED to one of
    // those forms still surfaces as drift (handled below), not folded away. (The three
    // tiers here mirror the `currentPaths` filter at the bottom of this function.)
    if (f.tier !== 'undeclared' && f.tier !== 'atDefault' && f.tier !== 'generated') {
      kept.push(f);
      continue;
    }
    // #674: on a REPLACED resource treat every recorded entry as absent — the snapshot
    // was taken against the old, deleted physical resource, so it must not match/suppress
    // or surface as "changed" against the brand-new one's fresh AWS defaults. The value
    // then folds through the tiers below (an at-default value folds; a genuine non-default
    // value on the new resource is unrecorded, not drift — the user never recorded IT).
    const entry = replacedLogical.has(f.logicalId)
      ? undefined
      : recorded.find((a) => entryMatches(a, f));
    // re-canonicalize the baseline value through the CURRENT pipeline before comparing
    // (f.actual is already canonical from classify): a baseline recorded under older
    // normalization rules still matches today's live, so a cdkrd version bump alone
    // never resurfaces a suppressed value as false drift.
    if (entry && baselineValueMatches(entry.value, f.actual)) continue; // recorded, unchanged
    if (entry) {
      // recorded value CHANGED -> drift. This takes PRIORITY over the at-default fold
      // below: a recorded NON-default value reset out of band to the AWS default is a
      // real out-of-band change (e.g. an undeclared MaxSessionDuration recorded at 7200,
      // reset to the 3600 default), so it must surface as drift, not be folded away as
      // inventory. classify tagged today's at-default value `atDefault`, which is NOT a
      // drift tier — force `undeclared` so the changed-from-baseline value is counted as
      // drift. For an identity-keyed object array (IAM inline Policies, …) attach the
      // element-level delta so the report shows WHICH element changed (R128, display-only;
      // the finding still names the whole-array path, so record/revert are unaffected).
      const delta = identityArrayDelta(canonicalizeForCompare(entry.value), f.actual);
      kept.push({ ...f, tier: 'undeclared', ...(delta && { arrayDelta: delta }) });
      continue;
    }
    if (f.tier === 'atDefault' || f.tier === 'generated') {
      // No recorded entry and the value equals a known AWS default / an AWS-generated
      // form (the equality gate proved it): folded inventory — never drift, never
      // unrecorded. A genuine change AWAY from it would not match and arrives as tier
      // 'undeclared', handled below; a recorded value changed TO it is the entry branch
      // above (drift).
      kept.push(f);
      continue;
    }
    if (complete.has(f.logicalId) && !replacedLogical.has(f.logicalId)) {
      // the record snapshot covered this whole resource, so this value is new. #674: a
      // REPLACED resource's completeness belongs to the OLD physical resource, so an
      // undeclared value on the new one is NOT "appeared since record" — fall through to
      // unrecorded (the user never recorded the replacement).
      kept.push({
        ...f,
        note: f.note ? `${f.note}; appeared since record` : 'appeared since record',
      });
    } else {
      kept.push({ ...f, unrecorded: true }); // never decided -> not drift
    }
  }
  // removed: recorded entries whose path is no longer present in any current
  // undeclared / at-default / generated finding (R86: a recorded value reclassified to
  // any of those undeclared-side tiers is still PRESENT — reconciled above as either
  // suppressed-unchanged or drift — not "removed"). Must match the reconciliation tier
  // set at the top of the loop, else a recorded value changed to a generated/at-default
  // form would be both surfaced as drift AND double-reported here as removed.
  const currentPaths = new Set(
    findings
      .filter((f) => f.tier === 'undeclared' || f.tier === 'atDefault' || f.tier === 'generated')
      .map((f) => `${f.logicalId}.${f.path}`)
  );
  // R134: baseline entries promoted into the template since record are a "clean up your
  // baseline" nudge, NOT drift — but emitting one note PER entry floods the output (a
  // config-dense stack can have dozens, e.g. every Lambda's LoggingConfig.* once CDK
  // starts declaring them). Collect them and emit ONE folded summary line (the `info:`
  // footer pattern), so a `revert` touching a single op no longer prints 20+ unrelated
  // lines. The fix is the same for every caller: re-run `record` to re-snapshot.
  // A resource that was SKIPPED this run (CC-API gap / transient read error / no
  // physical id — gather emits a `skipped` finding) was NOT observed, so its baseline
  // values are unknown, NOT removed. Excluding it prevents a transient skip from
  // flooding the report with false "baseline value removed since record" drift (its
  // values still exist; we just couldn't read them this run).
  //
  // A resource DELETED out of band already surfaces as a single resource-level
  // `deleted` finding (gather.ts), which SUBSUMES every recorded baseline value it
  // had — the whole resource is gone, so of course each of its values is too. Emitting
  // an extra per-property "baseline value removed" undeclared finding for each is
  // redundant noise that also inflates the drift COUNT (one deletion would read as
  // 1 + N drifts) and, for `revert`, yields un-actionable ops against a resource that
  // no longer exists. Suppress them too; the `deleted` finding carries the drift. (Gated
  // on an actual `deleted` finding, so a removal NOT already reported still surfaces.)
  const skippedLogical = new Set(
    findings.filter((f) => f.tier === 'skipped').map((f) => f.logicalId)
  );
  const deletedLogical = new Set(
    findings.filter((f) => f.tier === 'deleted').map((f) => f.logicalId)
  );
  // A recorded nested undeclared value whose DECLARED parent property is itself
  // drifting this run is subsumed by that `declared` finding: the parent array/object
  // changed (e.g. CloudFront `DistributionConfig.Origins` -> []), so the nested value's
  // disappearance is the SAME real change, not a separate "baseline value removed".
  // Emitting both double-counts the drift and yields an un-actionable revert op against
  // a nested path that no longer exists — the exact class already suppressed for
  // `deleted`/`skipped`. Suppress when a current `declared` finding's path is a prefix
  // of the recorded path (so a sibling NOT under the drifting parent still surfaces).
  const declaredDriftByLogical = new Map<string, string[]>();
  for (const f of findings) {
    if (f.tier !== 'declared') continue;
    const arr = declaredDriftByLogical.get(f.logicalId) ?? [];
    arr.push(f.path);
    declaredDriftByLogical.set(f.logicalId, arr);
  }
  const underDeclaredDrift = (logicalId: string, path: string): boolean =>
    (declaredDriftByLogical.get(logicalId) ?? []).some(
      (p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`)
    );
  const promotedStale: string[] = [];
  const removedFromTemplate: string[] = []; // #675
  const replacedStale: string[] = []; // #674
  const typeMismatchStale: string[] = []; // #793
  for (const a of recorded) {
    // PR4: an `added`-resource entry has an empty path (the whole resource is the value)
    // and is reconciled in the loop above, never here. If its live resource is gone the
    // out-of-band addition was simply removed — nothing to "restore", so skip it (a
    // property-removal note against a synthesized child id would be meaningless).
    if (a.path === '') continue;
    // #793: the logicalId now hosts a DIFFERENT resource type (id reused across a refactor),
    // so this entry belongs to the old type. Void it: without this the synthetic "removed
    // since record" finding below would pair the entry's OLD resourceType with the new
    // resource's LIVE physical id, so a revert would issue an op with the wrong TypeName.
    if (isTypeVoid(a)) {
      typeMismatchStale.push(`${a.logicalId}.${a.path}`);
      continue;
    }
    // #674: the resource was REPLACED by a deploy — this entry belongs to the old,
    // deleted physical resource, so it is void, not "removed since record". Fold it.
    if (replacedLogical.has(a.logicalId)) {
      replacedStale.push(`${a.logicalId}.${a.path}`);
      continue;
    }
    if (currentPaths.has(`${a.logicalId}.${a.path}`)) continue;
    if (skippedLogical.has(a.logicalId)) continue; // unread this run -> not "removed"
    if (deletedLogical.has(a.logicalId)) continue; // subsumed by the `deleted` finding
    if (underDeclaredDrift(a.logicalId, a.path)) continue; // subsumed by parent declared drift
    // #675: the resource is gone from the CURRENT template entirely (legitimately removed
    // from IaC and deleted by the deploy). It is in neither template nor live AWS —
    // nothing drifted, so fold into a nudge instead of a synthetic "removed since record"
    // finding. Gated on a KNOWN logical-id set (opts.allLogicalIds present) so a caller
    // that does not pass it keeps today's behavior.
    if (currentLogicalIds !== undefined && !currentLogicalIds.has(a.logicalId)) {
      removedFromTemplate.push(`${a.logicalId}.${a.path}`);
      continue;
    }
    // promoted into the template since record → not a removal, just stale baseline.
    // #749: gate on the FULL path (only meaningful for a top-level path), NOT its top
    // segment — otherwise every nested recorded value, whose top segment is a declared
    // key by construction, would be swallowed here and never surface as a removal.
    if (isTopLevelPath(a.path) && opts.declaredByLogical?.get(a.logicalId)?.has(a.path)) {
      promotedStale.push(`${a.logicalId}.${a.path}`);
      continue;
    }
    kept.push({
      tier: 'undeclared',
      logicalId: a.logicalId,
      resourceType: a.resourceType,
      // Restore the construct path that every LIVE finding for this resource carries
      // (a RecordedEntry doesn't store it). Without it, a constructPath-form ignore
      // rule — the form `cdkrd ignore` writes by preference — would NOT match this
      // synthetic "removed since record" finding (applyIgnores keys on constructPath
      // when present), so the removal would re-surface despite the ignore.
      ...(opts.constructPathByLogical?.get(a.logicalId) !== undefined && {
        constructPath: opts.constructPathByLogical.get(a.logicalId),
      }),
      // physical id so `revert` can act on it (a synthesized finding has no
      // resource.physicalId source — without this it is rejected as "no physical id").
      ...(opts.physicalIdByLogical?.get(a.logicalId) !== undefined && {
        physicalId: opts.physicalIdByLogical.get(a.logicalId),
      }),
      path: a.path,
      desired: a.value,
      actual: undefined,
      note: 'baseline value removed since record',
    });
  }
  if (promotedStale.length > 0) opts.warn?.(formatPromotedStaleNote(promotedStale));
  if (removedFromTemplate.length > 0)
    opts.warn?.(formatRemovedFromTemplateNote(removedFromTemplate));
  if (replacedStale.length > 0) opts.warn?.(formatReplacedStaleNote(replacedStale));
  if (typeMismatchStale.length > 0) opts.warn?.(formatTypeMismatchStaleNote(typeMismatchStale));
  return kept;
}

/**
 * The folded one-line note for baseline entries now declared in the template (R134). One
 * line with a count instead of one line per entry; `record` re-snapshots to clear them.
 * Pure + exported for unit tests.
 */
export function formatPromotedStaleNote(paths: string[]): string {
  const n = paths.length;
  const subject = n === 1 ? `baseline entry (${paths[0]}) is` : `${n} baseline entries are`;
  const them = n === 1 ? 'it' : 'them';
  return `note: ${subject} now declared in the template — re-run \`cdkrd record\` to clean ${them} up.`;
}

/**
 * #675: the folded one-line note for baseline entries whose resource is no longer in
 * the template at all (legitimately removed from IaC and deleted by the deploy). Mirror
 * of formatPromotedStaleNote. Pure + exported for unit tests.
 */
export function formatRemovedFromTemplateNote(paths: string[]): string {
  const n = paths.length;
  const subject = n === 1 ? `baseline entry (${paths[0]}) belongs` : `${n} baseline entries belong`;
  return `note: ${subject} to resources no longer in the template — re-run \`cdkrd record\` to clean them up.`;
}

/**
 * #674: the folded one-line note for baseline entries recorded against a resource that a
 * deploy has since REPLACED (new physical id). Mirror of formatPromotedStaleNote. Pure +
 * exported for unit tests.
 */
export function formatReplacedStaleNote(paths: string[]): string {
  const n = paths.length;
  const subject = n === 1 ? `baseline entry (${paths[0]}) was` : `${n} baseline entries were`;
  return `note: ${subject} recorded against a resource since REPLACED by a deploy — re-run \`cdkrd record\`.`;
}

/**
 * #793: the folded one-line note for baseline entries whose logicalId now hosts a resource
 * of a DIFFERENT type (the id was recycled across a template refactor). The old-type entries
 * are void against the new resource. Mirror of formatReplacedStaleNote. Pure + exported for
 * unit tests.
 */
export function formatTypeMismatchStaleNote(paths: string[]): string {
  const n = paths.length;
  const subject = n === 1 ? `baseline entry (${paths[0]}) was` : `${n} baseline entries were`;
  return `note: ${subject} recorded against a resource whose logicalId now has a DIFFERENT type — re-run \`cdkrd record\`.`;
}

/** logicalId -> set of declared top-level keys, for applyBaseline's promotion check. */
export function declaredKeysByLogical(
  resources: { logicalId: string; declared: Record<string, unknown> }[]
): Map<string, Set<string>> {
  return new Map(resources.map((r) => [r.logicalId, new Set(Object.keys(r.declared))]));
}

// logicalId -> construct path, for resources that carry one. Feeds
// ApplyBaselineOptions.constructPathByLogical so the synthetic removed-since-record
// finding can be matched by a constructPath-form ignore rule.
export function constructPathsByLogical(
  resources: { logicalId: string; constructPath?: string | undefined }[]
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of resources) if (r.constructPath !== undefined) m.set(r.logicalId, r.constructPath);
  return m;
}

// logicalId -> live physical id, for resources that resolved one. Feeds
// ApplyBaselineOptions.physicalIdByLogical so the synthetic removed-since-record
// finding carries a physical id and `revert` can restore the removed value.
export function physicalIdsByLogical(
  resources: { logicalId: string; physicalId?: string | undefined }[]
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of resources) if (r.physicalId !== undefined) m.set(r.logicalId, r.physicalId);
  return m;
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

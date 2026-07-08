// Per-stack record / revert actions, shared by the standalone `record` / `revert`
// commands AND `check`'s interactive after-drift prompt (R28). Extracting them keeps
// the interactive flow and the single-verb commands behaviourally identical: both go
// through exactly the same record / plan / apply / converge code.
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { confirm, isCancel } from '@clack/prompts';
import {
  recordedKey,
  applyBaseline,
  type BaselineFile,
  buildRecorded,
  carryForwardUnreadable,
  constructPathsByLogical,
  declaredKeysByLogical,
  loadBaseline,
  physicalIdsByLogical,
  selectRecorded,
  splitRecordedByBaseline,
  writeBaseline,
} from '../baseline/baseline-file.js';
import {
  addIgnoreRules,
  applyIgnores,
  type CdkrdConfig,
  ignoreRuleFor,
} from '../config/config-file.js';
import { withinStackPath } from '../construct-path.js';
import { style } from '../report/style.js';
import { bulkMultiselect } from './bulk-multiselect.js';
import { CC_IDENTIFIER_ADAPTERS } from '../read/router.js';
import { applyRevertDelete, applyRevertItem } from '../revert/apply.js';
import {
  buildRevertPlan,
  rejectedEmptyStripOps,
  type RevertItem,
  type RevertPlan,
  tagPreservingOps,
  writeOnlyReincludeOps,
} from '../revert/plan.js';
import { errorText, type RetryOptions, retryTransient } from '../revert/transient.js';
import { resolveSdkWriter } from '../revert/writers.js';
import { deepEqual } from '../diff/drift-calculator.js';
import type { Finding, SchemaInfo } from '../types.js';
import { type Desired } from '../desired/template-adapter.js';
import { buildSiblingSgRules, type GatherResult, regatherTouched } from './gather.js';

// unrecorded values (R62) are awaiting a decision, not drift — they never count
// toward "drift(s) remain" messaging or the convergence check.
const isDrift = (f: Finding): boolean =>
  (f.tier === 'deleted' ||
    f.tier === 'added' ||
    f.tier === 'declared' ||
    f.tier === 'undeclared') &&
  !f.unrecorded;
const driftCount = (findings: Finding[]): number => findings.filter(isDrift).length;
const unrecordedCount = (findings: Finding[]): number =>
  findings.filter((f) => f.unrecorded === true).length;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The revert confirm message (R52). When NOT-revertable findings exist (e.g. a
 * no-baseline first check with one declared drift and 100+ undeclared values),
 * users read "This WRITES to AWS" as "everything I just saw gets written" —
 * state explicitly that ONLY the listed op(s) are written and the rest is
 * untouched. Pure + exported so the wording is unit-tested.
 */
export function revertConfirmMessage(
  stackName: string,
  opCount: number,
  notRevertableCount: number
): string {
  const scope =
    notRevertableCount > 0
      ? ` Only the ${opCount} selected op(s) are written — the ${notRevertableCount} NOT-revertable finding(s) are untouched.`
      : '';
  return `Apply ${opCount} revert op(s) to ${stackName}? This WRITES to AWS.${scope}`;
}

/**
 * The post-revert surviving-drift pointer list (R46), capped (R52): after a
 * partial revert on a no-baseline stack, every unrecorded undeclared value
 * "survives" — re-listing 100+ lines the user just saw in the report is noise.
 * Show up to `cap` entries, then a one-line fold. Pure + exported for tests.
 */
export function formatSurvivingDrift(remaining: Finding[], stackName = '', cap = 10): string[] {
  const idOf = (f: Finding): string =>
    f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId;
  const lines = remaining
    .slice(0, cap)
    .map((f) => `  - ${idOf(f)}${f.path ? `.${f.path}` : ''} (${f.tier})`);
  if (remaining.length > cap)
    lines.push(`  ... and ${remaining.length - cap} more — run \`cdkrd check\` for the full list`);
  return lines;
}

/**
 * Header for record's multiselect (R49, R116). The key hints (space / → / ← / enter)
 * are rendered by `bulkMultiselect` itself, so this is just the one-line prompt. When
 * `foldedCount` > 0 it DISCLOSES that those nested sub-keys are recorded too — the picker
 * lists only the standout rows, so without this the user could see (say) one row and not
 * realise enter also records the folded values. The folded values are NOT individually
 * deselectable here: "record only the standout, keep the folded reported" has no use case
 * (the folded would just nag forever), whereas deselecting a standout to "record the rest"
 * IS useful — so standouts toggle, the folded always record. Pure + exported.
 */
export function recordSelectMessage(stackName: string, foldedCount = 0): string {
  const fold =
    foldedCount > 0
      ? `; +${foldedCount} folded sub-key(s) ALWAYS recorded too (--verbose to itemize)`
      : '';
  return `${stackName}: select undeclared value(s) to record (unselected stay reported)${fold}`;
}

/**
 * Split the to-record delta into STANDOUT (itemized in the record multiselect) and FOLDED
 * (nested live-only sub-keys — the `undeclared-subkey` mass the report folds, R96). Folded
 * entries are auto-recorded as a summarized count instead of dozens of rows. `expandNested`
 * (--verbose) turns the fold off so every nested value is itemized. An entry is folded when
 * its matching gather finding is a `nested` undeclared value — EXCEPT a free-form map key
 * (freeFormKey), which the report shows in full, so the picker itemizes it too. Pure + exported.
 */
export function splitFoldedNested<T extends { logicalId: string; path: string }>(
  changed: T[],
  findings: Finding[],
  expandNested: boolean | undefined
): { standout: T[]; folded: T[] } {
  if (expandNested) return { standout: changed, folded: [] };
  const nestedKeys = new Set(
    findings
      .filter((f) => f.nested === true && f.tier === 'undeclared' && !f.freeFormKey)
      .map((f) => `${f.logicalId}::${f.path}`)
  );
  const isFolded = (e: T): boolean => nestedKeys.has(`${e.logicalId}::${e.path}`);
  return { standout: changed.filter((e) => !isFolded(e)), folded: changed.filter(isFolded) };
}

/**
 * Post-record scope note (or undefined). `record` snapshots UNDECLARED state and (PR4)
 * out-of-band `added` resources into the baseline — but it CANNOT silence DECLARED or
 * DELETED drift, which is divergence from your template intent a baseline does not
 * govern (`buildRecorded` keeps only undeclared + added). Users read "record" as
 * "approve EVERYTHING I just saw", so when declared/deleted drift is present say plainly
 * that it was NOT approved and still stands. Resolution: revert it, `cdkrd ignore` it
 * (declared — stop reporting), or `cdk deploy`. Pure + exported (emitted by both `cdkrd
 * record` and check's interactive record, so the scope is stated wherever record runs —
 * previously only check's path warned). R117.
 */
export function recordScopeNote(stackName: string, findings: Finding[]): string | undefined {
  const n = findings.filter((f) => f.tier === 'declared' || f.tier === 'deleted').length;
  if (n === 0) return undefined;
  return `note: ${stackName}: record snapshotted undeclared + added state into the baseline only — ${n} declared/deleted drift NOT approved (it still reports as drift; resolve with cdkrd revert, cdkrd ignore, or cdk deploy).`;
}

/**
 * The success line after a record writes the baseline. Three outcomes (R142):
 *  - refreshed: nothing new to decide, the already-recorded unchanged set was re-snapshotted;
 *  - initialized: the FIRST baseline on a CLEAN stack (no prior file, zero recorded entries)
 *    — a day-1 INITIALIZATION, not a no-op, so it states what it established (the stack is now
 *    tracked → a later out-of-band undeclared value reports as drift) rather than the cold
 *    "(0 recorded entry(ies))" that read as "nothing happened";
 *  - written: the normal case, N recorded entries.
 * Pure + exported so the wording is unit-tested. `count` is undeclared values + (PR4)
 * out-of-band added resources — "recorded entry(ies)" covers both.
 */
export function recordOutcomeMessage(
  stackName: string,
  path: string,
  count: number,
  refreshedOnly: boolean,
  hadPriorBaseline: boolean
): string {
  if (refreshedOnly)
    return `${stackName}: nothing new to record — baseline refreshed (${count} unchanged value(s))`;
  if (!hadPriorBaseline && count === 0)
    return `${stackName}: baseline initialized — ${path} (no undeclared values to record; this stack is now tracked — future out-of-band changes report as drift)`;
  return `baseline written: ${path} (${count} recorded entry(ies))`;
}

/**
 * Build the interactive revert multiselect options from a plan (R57). Revert is
 * now symmetric with record: choosing Revert lets you pick WHICH op(s) to write
 * — "select the things to revert" is the user's natural reading of the flow.
 * EVERY op starts UNSELECTED (R137): revert is the one AWS-mutating verb, so nothing
 * is pre-armed — the user opts in to each write explicitly (→ selects all at once).
 * Pre-selecting RESTORE ops but not REMOVE ops was a confusing asymmetry: a console
 * change to a declared property would be silently primed for write-back while an
 * undeclared one was not. REMOVE ops still carry a (REMOVE) label so a destructive
 * delete is visible. Pure + exported.
 */
export function revertSelectOptions(
  plan: RevertPlan
): { value: string; label: string; selected: boolean }[] {
  const options: { value: string; label: string; selected: boolean }[] = [];
  for (const item of plan.items) {
    for (const op of item.ops) {
      // `delete` items delete a whole out-of-band resource — the loudest destructive
      // action, marked (DELETE); a property REMOVE keeps its (REMOVE) marker.
      const marker = item.kind === 'delete' ? ' (DELETE)' : op.op === 'remove' ? ' (REMOVE)' : '';
      options.push({
        value: revertOpKey(item, op),
        label: `${item.displayId}: ${op.human}${marker}`,
        selected: false,
      });
    }
  }
  return options;
}

function revertOpKey(item: RevertItem, op: RevertItem['ops'][number]): string {
  // Include attributeKey: ELB attribute-bag ops all share one op.path
  // (/LoadBalancerAttributes) and differ only by attributeKey, so without it every
  // bag attribute collapses to one multiselect row and toggles as a unit. Non-bag
  // ops have no attributeKey, so their key is unchanged.
  const attr = op.attributeKey !== undefined ? `${op.attributeKey}` : '';
  return `${item.logicalId}${item.kind}${op.path}${attr}`;
}

/** Keep only the selected ops; items left with no ops drop out. Pure + exported. */
export function filterRevertPlan(plan: RevertPlan, picked: Set<string>): RevertPlan {
  const items = plan.items
    .map((item) => ({ ...item, ops: item.ops.filter((op) => picked.has(revertOpKey(item, op))) }))
    .filter((item) => item.ops.length > 0);
  return { items, notRevertable: plan.notRevertable };
}

export function revertSelectMessage(stackName: string): string {
  return `${stackName}: select the op(s) to revert (unselected are not written)`;
}

// ---- record ----

export interface RecordStackParams {
  stackName: string;
  region: string;
  desired: Desired;
  findings: Finding[]; // the gather's findings (undeclared still present, pre-baseline)
  yes: boolean;
  interactive: boolean; // whether the multiselect decision prompt may be shown (TTY only)
  // check's "Decide per finding" path (R121): the user already chose WHICH undeclared
  // values to record in the action picker, so recordStack skips its own multiselect and
  // records exactly these (keyed by recordedKey). Already-recorded unchanged values are
  // still auto-kept, so this never drops the rest of the baseline.
  preselectedKeys?: Set<string>;
  // Mirror the report's R96 fold: by default the record multiselect itemizes only the
  // STANDOUT (non-nested) undeclared values and auto-records the nested live-only sub-keys
  // (the `undeclared-subkey` mass the report folds) as a summarized count, instead of
  // listing dozens of nested rows. `--verbose` sets this true to itemize every nested
  // value individually (mirrors the report's --verbose fold-expansion; --show-all is the
  // separate inventory mode and suppresses the interactive prompt, so it never reaches here).
  expandNested?: boolean;
}

/**
 * Outcome of a per-stack record.
 *  - `wrote`: a baseline file was written.
 *  - `refused`: true ONLY when a decision was required (undeclared values to record)
 *    but the run is non-interactive and `--yes` was not passed — record refuses
 *    rather than recording everything by default (R38). A user-cancelled multiselect
 *    is `{ wrote:false, refused:false }`, not a refusal.
 */
export interface RecordResult {
  wrote: boolean;
  refused: boolean;
}

/**
 * Record the current undeclared state into the baseline file. In an interactive run
 * (no --yes) the user picks WHICH undeclared values to record (selective record, R14).
 * When an existing baseline is present the multiselect shows only the DELTA from it
 * (new/changed); already-recorded unchanged values are auto-kept and surfaced with a
 * note (R39). An empty FINAL set is confirmed first (R19). Non-interactively
 * (non-TTY: CI/cron/pipes), the multiselect is a required DECISION: with
 * undeclared values present and no --yes, record refuses (exit 2) instead of recording
 * all (R38). When there is nothing to decide (no undeclared values) the baseline is
 * written regardless. (Same flow whether reached via `cdkrd record` or check's
 * interactive prompt — neither re-gathers.)
 */
export async function recordStack(p: RecordStackParams): Promise<RecordResult> {
  const { stackName, region, desired, findings, yes, interactive, preselectedKeys, expandNested } =
    p;
  const existing = await loadBaseline(stackName, desired.accountId, region);
  if (!yes && existing)
    console.error(
      `note: ${stackName}: will overwrite the existing baseline file on confirm (nothing written yet; it is git-tracked — review the diff afterwards). Pass --yes to silence.`
    );
  // Seed with this run's observed entries, then carry forward any prior baseline
  // entries for resources this run could NOT read (skipped / model-read-failed) so a
  // re-record never silently shrinks the committed baseline (writeBaseline full-replaces).
  let recorded = carryForwardUnreadable(buildRecorded(findings), existing, findings);
  let refreshedOnly = false; // true when only unchanged values remained (no delta to decide)
  if (!yes && recorded.length > 0) {
    // A decision is required (which undeclared values to record). Non-interactively
    // we refuse rather than implicitly record ALL of them (R38).
    if (!interactive) {
      console.error(
        `error: record needs a decision — pass --yes to record ALL undeclared values, or run interactively`
      );
      return { wrote: false, refused: true };
    }
    // Only make the human decide on the DELTA from the existing baseline: already-recorded
    // unchanged values are auto-kept (re-confirming a 50-item snapshot every time is wrong,
    // R39). With no baseline the split returns everything as `changed` (the true first record).
    const { unchanged, changed } = splitRecordedByBaseline(recorded, existing);
    if (unchanged.length > 0)
      console.error(
        `note: ${stackName}: keeping ${unchanged.length} already-recorded unchanged value(s)`
      );
    if (changed.length === 0) {
      // Nothing new to decide — just refresh the baseline (re-snapshot the unchanged set).
      recorded = unchanged;
      refreshedOnly = true;
    } else {
      // Per-finding path: the action picker already chose the keys, so take them
      // directly (no second prompt). Otherwise show the record multiselect.
      let picked: string[];
      if (preselectedKeys) {
        picked = changed.map((e) => recordedKey(e)).filter((k) => preselectedKeys.has(k));
      } else {
        // Mirror the report's R96 fold: itemize only the STANDOUT (non-nested) values; the
        // folded nested sub-keys (the `undeclared-subkey` mass) are ALWAYS recorded and the
        // header discloses the count. They are deliberately NOT individually deselectable —
        // "record only the standout, keep the folded reported" has no use case (the folded
        // would just nag forever), while deselecting a standout to "record the rest" stays
        // possible (the folded still record). To record nothing, cancel (esc). `--verbose`
        // (expandNested) itemizes every nested value as its own row instead (`--show-all` is
        // the separate inventory mode — it suppresses this prompt, so it can't itemize here).
        const { standout, folded } = splitFoldedNested(changed, findings, expandNested);
        if (standout.length === 0) {
          // Nothing to itemize (every changed value is a folded nested sub-key — the common
          // all-nested first run). A Yes/No commit replaces the empty multiselect.
          const proceed = await confirm({
            message: `${stackName}: record ${folded.length} undeclared sub-key value(s)? (--verbose to itemize each)`,
            initialValue: true,
          });
          if (isCancel(proceed) || !proceed) {
            console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
            return { wrote: false, refused: false };
          }
          picked = changed.map((e) => recordedKey(e));
        } else {
          const fromPrompt = await bulkMultiselect(
            recordSelectMessage(stackName, folded.length),
            // default = all selected (→/← bulk-toggle from there)
            standout.map((e) => ({
              value: recordedKey(e),
              // an `added`-resource entry (PR4) has an empty path — the whole resource is
              // the value — so omit the trailing dot and tag it as a resource snapshot.
              label: e.path ? `${e.logicalId}.${e.path}` : `${e.logicalId} (added resource)`,
              selected: true,
            }))
          );
          if (fromPrompt === undefined) {
            console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
            return { wrote: false, refused: false };
          }
          // the folded nested values are always recorded alongside the picked standouts
          picked = [...fromPrompt, ...folded.map((e) => recordedKey(e))];
        }
      }
      const selectedChanged = selectRecorded(findings, new Set(picked));
      recorded = [...unchanged, ...selectedChanged]; // auto-kept unchanged + the user's picks
      // The FINAL written set being empty (no unchanged + nothing picked) writes an EMPTY
      // baseline. Since R62 that no longer arms revert removal (unrecorded values stay
      // guarded per entry) — it just records "I decided nothing", so the values keep
      // being reported as unrecorded. Still confirm: writing a file that changes nothing
      // is more likely a mis-keyed multiselect than an intent (R19, defanged by R62).
      // Skipped on the per-finding path: the picker is the decision, no extra confirm.
      if (recorded.length === 0 && !preselectedKeys) {
        const proceed = await confirm({
          message: `${stackName}: record nothing? This writes an EMPTY baseline — every undeclared value stays reported as unrecorded.`,
          initialValue: false,
        });
        if (isCancel(proceed) || !proceed) {
          console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
          return { wrote: false, refused: false };
        }
      }
    }
  }
  const { path, count } = await writeBaseline(
    stackName,
    region,
    desired.accountId,
    findings,
    desired.rawTemplate,
    recorded,
    // full resource list (read-clean resources are snapshot-complete too) +
    // previous baseline so completeness stays monotonic across re-records (R62) +
    // #674: per-resource physical id so a later REPLACING deploy can void stale entries
    {
      allLogicalIds: desired.resources.map((r) => r.logicalId),
      previous: existing,
      physicalIdByLogical: physicalIdsByLogical(desired.resources),
    }
  );
  console.log(style.ok(recordOutcomeMessage(stackName, path, count, refreshedOnly, !!existing)));
  // record's scope excludes declared/deleted: if such drift is present, say so —
  // it was NOT approved by this record and still stands (R117).
  const scopeNote = recordScopeNote(stackName, findings);
  if (scopeNote) console.error(scopeNote);
  return { wrote: true, refused: false };
}

// ---- ignore ----

export interface IgnoreStackParams {
  stackName: string;
  // baseline-reconciled findings — ignore targets the declared + undeclared tiers
  // (the same set applyIgnores can re-tag). Already-ignored findings are tier
  // `ignored`, so they never re-appear here.
  findings: Finding[];
  yes: boolean;
  interactive: boolean; // whether the multiselect decision prompt may be shown (TTY only)
}

/**
 * Outcome of a per-stack ignore.
 *  - `wrote`: at least one NEW rule was appended to `.cdkrd/ignore.yaml`.
 *  - `refused`: true ONLY when a decision was required (ignorable findings present)
 *    but the run is non-interactive and `--yes` was not passed — like record, ignore
 *    refuses rather than ignoring everything by default.
 *  - `added`: how many new rules were written (0 when all were already present, or on
 *    a cancel/refusal).
 */
export interface IgnoreResult {
  wrote: boolean;
  refused: boolean;
  added: number;
}

/** Header for ignore's multiselect. The key hints are rendered by `bulkMultiselect`
 *  itself, so this is just the one-line prompt. Pure + exported for unit tests. */
export function ignoreSelectMessage(stackName: string): string {
  return `${stackName}: select drift to ignore — stops reporting it (writes .cdkrd/ignore.yaml)`;
}

// Unique per-finding key for the multiselect (logicalId+path is unique within a stack;
// the WRITTEN rule is ignoreRuleFor, which may instead use the friendlier constructPath).
const ignoreFindingKey = (f: Finding): string => `${f.logicalId}::${f.path}`;

/**
 * The ignore multiselect rows. EVERY row starts UNSELECTED (→ selects all) — mirroring
 * revert's picker (R137): ignore STOPS watching permanently, and check's interactive flow
 * can route folded undeclared inventory here, so a default-all selection would let an
 * Enter ignore values the user never saw in the report. Opt-in, not opt-out. Pure +
 * exported so the "starts unselected" invariant is unit-tested without a TTY.
 */
export function ignoreSelectOptions(
  ignorable: Finding[],
  stackName = ''
): { value: string; label: string; selected: boolean }[] {
  return ignorable.map((f) => {
    const id = f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId;
    return {
      value: ignoreFindingKey(f),
      label: `${id}${f.path ? `.${f.path}` : ''} (${f.tier})`,
      selected: false,
    };
  });
}

/**
 * Write `ignore` rules into `.cdkrd/ignore.yaml` for the chosen declared/undeclared
 * findings — they stop being reported entirely (re-tagged `ignored` on the next check),
 * the "stop watching" counterpart to record's "keep watching". Interactive runs pick
 * WHICH findings to ignore (default NONE selected — → selects all, R137); `--yes`
 * ignores all shown.
 * Non-interactively without `--yes` it refuses (a required decision, like record, R38).
 * Idempotent: rules already in the file are reported, not duplicated. Shared by `cdkrd
 * ignore` and (PR-B2) check's interactive flow, so both write rules identically.
 */
export async function ignoreStack(p: IgnoreStackParams): Promise<IgnoreResult> {
  const { stackName, findings, yes, interactive } = p;
  // ignore is symmetric with revert (declared + undeclared + added), unlike record
  // (undeclared only) — it fills the gap of accepting a DECLARED or out-of-band ADDED
  // drift in-tool.
  const ignorable = findings.filter(
    (f) => f.tier === 'declared' || f.tier === 'undeclared' || f.tier === 'added'
  );
  if (ignorable.length === 0) {
    console.log(style.clean(`${stackName}: no ignorable drift to ignore.`));
    return { wrote: false, refused: false, added: 0 };
  }
  let chosen = ignorable;
  if (!yes) {
    if (!interactive) {
      console.error(
        `error: ignore needs a decision — pass --yes to ignore ALL shown drift, or run interactively`
      );
      return { wrote: false, refused: true, added: 0 };
    }
    const picked = await bulkMultiselect(
      ignoreSelectMessage(stackName),
      ignoreSelectOptions(ignorable, stackName)
    );
    if (picked === undefined) {
      console.error(`note: ${stackName}: ignore cancelled — config unchanged`);
      return { wrote: false, refused: false, added: 0 };
    }
    const set = new Set(picked);
    chosen = ignorable.filter((f) => set.has(ignoreFindingKey(f)));
    if (chosen.length === 0) {
      console.error(`note: ${stackName}: nothing selected — config unchanged`);
      return { wrote: false, refused: false, added: 0 };
    }
  }
  const { path, added, alreadyPresent } = await addIgnoreRules(
    chosen.map((f) => ignoreRuleFor(f, stackName))
  );
  if (added.length > 0) {
    const dup = alreadyPresent.length > 0 ? `, ${alreadyPresent.length} already present` : '';
    console.log(style.ok(`ignore rule(s) added: ${path} (${added.length} new${dup})`));
  } else {
    console.log(
      style.note(
        `${stackName}: all ${alreadyPresent.length} selected rule(s) already present — config unchanged`
      )
    );
  }
  return { wrote: added.length > 0, refused: false, added: added.length };
}

// ---- revert ----

export interface PlanDisplayOptions {
  verbose?: boolean; // expand the NOT-revertable per-reason summary to the full per-finding list
  unrecordedGuidance?: boolean; // unrecorded values present → lead with the record-or-remove fork
}

/**
 * Render the revert plan (pure — exported for unit tests; printPlan logs it).
 * Revertable items are ALWAYS full detail — confirming what will be written to AWS
 * is the point of the plan. NOT-revertable findings fold into one line per reason
 * (count + reason — same idea as check's `info:` footer, R25/R35); `--verbose`
 * expands them to the full per-finding list.
 */
export function formatPlan(
  stackName: string,
  region: string,
  plan: RevertPlan,
  opts: PlanDisplayOptions = {}
): string[] {
  const lines: string[] = [`\n=== revert: ${stackName} (${region}) ===`];
  if (opts.unrecordedGuidance) {
    // A fork, not a sequence (R55): recording these values endorses them (they
    // leave the report) — it is NOT a step toward reverting them.
    lines.push(
      `\nnote: ${stackName} has unrecorded value(s) — never recorded, so there is no recorded state to restore.`,
      '      If the live values are RIGHT, record them (they leave the report);',
      '      if they should be REMOVED, re-run revert with --remove-unrecorded.'
    );
  }
  // A resource can split into MORE THAN ONE plan item (a Cloud Control `cc` item plus a
  // prop-scoped `sdk` item route through different writers — e.g. a Logs LogGroup whose
  // RetentionInDays reverts via CC while BearerTokenAuthenticationEnabled reverts via the
  // SDK writer). Merge them into ONE block per resource so the listing reads per-resource,
  // not per-writer-group (two identical-header blocks for the same resource is confusing).
  const planByResource = new Map<
    string,
    { displayId: string; resourceType: string; humans: string[] }
  >();
  for (const item of plan.items) {
    const g = planByResource.get(item.logicalId);
    const humans = item.ops.map((op) => op.human);
    if (g) g.humans.push(...humans);
    else
      planByResource.set(item.logicalId, {
        displayId: item.displayId,
        resourceType: item.resourceType,
        humans,
      });
  }
  for (const g of planByResource.values()) {
    lines.push(`\n  ${g.displayId} (${g.resourceType})`);
    for (const h of g.humans) lines.push(`    - ${h}`);
  }
  if (plan.notRevertable.length > 0) {
    if (opts.verbose) {
      lines.push(`\n  NOT revertable (${plan.notRevertable.length}):`);
      for (const n of plan.notRevertable)
        lines.push(`    - ${n.displayId}.${n.path} (${n.resourceType}) — ${n.reason}`);
    } else {
      const counts = new Map<string, number>();
      for (const n of plan.notRevertable) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1);
      const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      groups.forEach(([reason, count], i) => {
        lines.push(
          i === 0
            ? `\n  NOT revertable: ${count} (${reason})`
            : `                · ${count} (${reason})`
        );
      });
      lines.push('    (run with --verbose for the full list)');
    }
  }
  return lines;
}

/** Collapse per-item apply results into ONE outcome per resource (logical id). A
 *  resource that split into a `cc` item and a prop-scoped `sdk` item produced two
 *  results; print a single `reverted:` line for it when every item succeeded, and a
 *  single `FAILED:` line (joining the failing writers' errors) when any did not — so a
 *  fully reverted resource never prints twice and a partial failure is never shown as a
 *  plain success. Insertion order (first item per resource) is preserved. */
export function summarizeRevertResults(
  applied: readonly {
    logicalId: string;
    displayId: string;
    ok: boolean;
    error?: string;
    hint?: string;
  }[]
): { displayId: string; ok: boolean; error?: string; hint?: string }[] {
  const byResource = new Map<
    string,
    { displayId: string; ok: boolean; errors: string[]; hints: string[] }
  >();
  for (const a of applied) {
    const g = byResource.get(a.logicalId) ?? {
      displayId: a.displayId,
      ok: true,
      errors: [],
      hints: [],
    };
    if (!a.ok) {
      g.ok = false;
      if (a.error) g.errors.push(a.error);
      // Collapse duplicate hints (a cc + sdk split can both fail transiently) to one line.
      if (a.hint && !g.hints.includes(a.hint)) g.hints.push(a.hint);
    }
    byResource.set(a.logicalId, g);
  }
  return [...byResource.values()].map((g) =>
    g.ok
      ? { displayId: g.displayId, ok: true }
      : {
          displayId: g.displayId,
          ok: false,
          error: g.errors.join('; '),
          ...(g.hints.length > 0 && { hint: g.hints.join('; ') }),
        }
  );
}

function printPlan(
  stackName: string,
  region: string,
  plan: RevertPlan,
  opts: PlanDisplayOptions
): void {
  // formatPlan stays pure/plain (unit-tested verbatim); only the banner line is
  // styled here, at the printing edge.
  for (const line of formatPlan(stackName, region, plan, opts)) {
    console.log(line.startsWith('\n=== ') ? '\n' + style.header(line.slice(1)) : line);
  }
}

export interface RevertStackParams {
  stackName: string;
  region: string;
  gathered: GatherResult; // the check/revert gather (findings + desired + schemas)
  baseline: BaselineFile | undefined;
  config: CdkrdConfig; // .cdkrd/ignore.yaml ignore rules (ignored findings drop out of the plan)
  dryRun: boolean;
  yes: boolean;
  removeUnrecorded: boolean;
  verbose: boolean; // expand the NOT-revertable summary to the full list
  interactive: boolean; // whether the confirm prompt may be shown (TTY only)
  // check's "Decide per finding" path (R121): the user already chose WHICH findings to
  // revert (passed in via gathered.findings), so revertStack skips its own op-multiselect
  // and reverts every op of the plan — but STILL shows the AWS-write confirm. Off by
  // default, so the standalone `revert` keeps its per-op multiselect.
  autoSelectAll?: boolean;
  // Delay before the single convergence re-read retry (SDK-writer paths can lag
  // behind their API response — eventual consistency). Overridable so unit tests
  // don't sleep for real.
  convergeRetryDelayMs?: number;
  // `revert --wait[=DURATION]` (issue #467): on a TRANSIENT "resource is mid-update"
  // failure (RSLVR-00705 & friends), keep retrying the write until the resource settles
  // (up to this many ms) instead of stopping at the short default backoff — so a
  // minutes-long UPDATING window converges in one command. undefined = default backoff.
  waitMs?: number;
  // Injected clock/sleep for the wait path so deadline-mode unit tests don't sleep.
  waitNow?: () => number;
  waitSleep?: (ms: number) => Promise<void>;
}

const CONVERGE_RETRY_DELAY_MS = 3000;

/**
 * Outcome of a per-stack revert.
 *  - `exit`: the exit contribution — 0 clean / 1 drift remains (including "drift
 *    exists but nothing is revertable", R35) / 2 apply failure (or a non-interactive
 *    write refusal).
 *  - `aborted`: true ONLY when the user cancelled the confirm prompt (no AWS write
 *    happened). The standalone `revert` command treats an abort as exit 0 (nothing
 *    changed), but `check`'s interactive flow must NOT let an abort drop a drifted
 *    stack to exit 0 — it keeps the pre-revert exit 1 (symmetric with "Nothing").
 *    See R30.
 */
export interface RevertOutcome {
  exit: number;
  aborted: boolean;
}

/**
 * Build the revert plan from the gather's findings + baseline, show it, confirm
 * (unless --yes / --dry-run), apply via Cloud Control / SDK writers, then re-gather
 * to verify convergence. Does NOT re-gather to build the plan (uses the passed
 * gather) — only the convergence re-check re-gathers.
 */
// R113: whether to include the REMOVE of standout undeclared (unrecorded) values in
// a revert. The explicit `--remove-unrecorded` flag always includes them. Otherwise
// include them ONLY when an interactive multiselect will be shown to gate them
// per-item (TTY and not --yes) — its unselected-by-default REMOVE rows ARE the
// consent the flag provides. A no-prompt run (--yes or non-TTY) keeps requiring the
// flag, since there is nothing to opt in with. Pure + exported for tests.
export function includeUnrecordedRemovals(
  removeUnrecorded: boolean,
  interactive: boolean,
  yes: boolean
): boolean {
  return removeUnrecorded || (interactive && !yes);
}

export async function revertStack(p: RevertStackParams): Promise<RevertOutcome> {
  const {
    stackName,
    region,
    gathered,
    baseline,
    config,
    dryRun,
    yes,
    removeUnrecorded,
    verbose,
    interactive,
    autoSelectAll,
    waitMs,
    waitNow,
    waitSleep,
  } = p;
  let worst = 0;
  // R113: a standout undeclared value is surfaced to the user as [Potential Drift] (it is
  // NOT a folded default — we deliberately show it), so, like declared drift, it
  // belongs in the revert list. Reverting an undeclared value REMOVES it (cdk drift
  // reports the same values and `cdk deploy --revert-drift` removes them). The
  // multiselect's REMOVE rows start UNSELECTED, so listing them is the per-item
  // consent that `--remove-unrecorded` provides non-interactively — no flag needed in
  // a gated prompt. A no-prompt run (--yes or non-TTY) has no multiselect to gate, so
  // it still requires the explicit flag.
  const includeRemovals = includeUnrecordedRemovals(removeUnrecorded, interactive, yes);
  const declaredByLogical = declaredKeysByLogical(gathered.desired.resources);
  // physicalId + constructPath maps so a synthesized "baseline value removed since
  // record" finding carries them — physicalId lets `revert` actually restore the
  // removed value (else buildRevertPlan rejects it "no physical id"); constructPath
  // lets a constructPath-form ignore rule match it during applyIgnores.
  const physicalIdByLogical = physicalIdsByLogical(gathered.desired.resources);
  const constructPathByLogical = constructPathsByLogical(gathered.desired.resources);
  // #675: the current template's logical-id set so applyBaseline can fold recorded
  // entries whose resource was removed from the template. #674 reuses physicalIdByLogical
  // (LIVE physical ids) to void entries recorded against a since-REPLACED resource.
  const allLogicalIds = gathered.desired.resources.map((r) => r.logicalId);
  const baselineOpts = {
    declaredByLogical,
    physicalIdByLogical,
    constructPathByLogical,
    allLogicalIds,
  };
  const drifted = applyIgnores(
    applyBaseline(gathered.findings, baseline, { ...baselineOpts, warn: console.error }),
    { stackName, accountId: gathered.desired.accountId, region },
    config
  );
  let plan = buildRevertPlan(drifted, baseline, {
    removeUnrecorded: includeRemovals,
    schemas: gathered.schemas,
    siblingSgRules: buildSiblingSgRules(gathered.desired),
    stackName,
  });

  if (plan.items.length === 0 && plan.notRevertable.length === 0) {
    console.log(style.clean(`${stackName} (${region}): no drift to revert.`));
    return { exit: 0, aborted: false };
  }
  printPlan(stackName, region, plan, {
    verbose,
    // Only when the unrecorded guard actually fires: with removals included the plan
    // REMOVES those values, so a "no revert target — record first" note would
    // contradict the plan printed right below it (R35 review).
    unrecordedGuidance: !includeRemovals && drifted.some((f) => f.unrecorded === true),
  });
  if (plan.items.length === 0) {
    // Findings exist but none are revertable (R35). That is NOT the clean
    // "no drift to revert" case — the findings still stand, so exit 1 (the same
    // "drift remains" semantics as a post-apply non-convergence; not a usage
    // error). Unrecorded values are named as such, not folded into "drift" (R62).
    const dc = driftCount(drifted);
    const uc = unrecordedCount(drifted);
    const parts = [
      ...(dc > 0 ? [`${dc} drift(s)`] : []),
      ...(uc > 0 ? [`${uc} unrecorded value(s)`] : []),
    ];
    console.log('\n' + style.drift(`nothing revertable — ${parts.join(' + ')} remain.`));
    return { exit: 1, aborted: false };
  }

  if (dryRun) {
    const opCount = plan.items.reduce((n, i) => n + i.ops.length, 0);
    console.log(
      `\n(dry-run) would apply ${opCount} op(s) to ${plan.items.length} resource(s). No changes made.`
    );
    return { exit: 0, aborted: false };
  }
  if (!yes) {
    if (!interactive) {
      console.error(
        `\nrefusing to write to AWS non-interactively — pass --yes to apply (or --dry-run to preview).`
      );
      return { exit: 2, aborted: false };
    }
    // R57: pick WHICH op(s) to write — symmetric with record's multiselect.
    // RESTORE ops are pre-selected; REMOVE ops start unselected (an explicit
    // per-item opt-in to deleting a live value). Selecting nothing aborts.
    // Skipped on the per-finding path (autoSelectAll): the action picker already chose
    // the findings, so revert every op of the plan — but still confirm the AWS write.
    if (!autoSelectAll) {
      const picked = await bulkMultiselect(
        revertSelectMessage(stackName),
        revertSelectOptions(plan)
      );
      if (picked === undefined) {
        console.log(style.note('aborted.'));
        return { exit: 0, aborted: true };
      }
      plan = filterRevertPlan(plan, new Set(picked));
      if (plan.items.length === 0) {
        console.log(style.note('nothing selected — aborted.'));
        return { exit: 0, aborted: true };
      }
    }
    const opCount = plan.items.reduce((n, i) => n + i.ops.length, 0);
    const ok = await confirm({
      message: revertConfirmMessage(stackName, opCount, plan.notRevertable.length),
    });
    if (isCancel(ok) || !ok) {
      console.log(style.note('aborted.'));
      return { exit: 0, aborted: true };
    }
  }

  const cc = new CloudControlClient({ region });
  const byLogical = new Map(gathered.desired.resources.map((res) => [res.logicalId, res]));
  // `added` delete items have a SYNTHESIZED logicalId (not a template resource), so the
  // scoped convergence re-read below cannot regenerate them — a SUCCESSFUL delete then
  // correctly vanishes from `post`, but a FAILED one would vanish too (reading as CLEAN).
  // Track the failed ones and re-add their findings so they still count as drift.
  const failedDeleteIds = new Set<string>();
  // #631: a FAILED update/sdk op (the SNS FilterPolicyScope `remove` that hard-fails
  // InvalidRequest[null]) must count as UNCONFIRMED — the same "never claim convergence we
  // could not verify" principle that already covers failed deletes. Without this a FAILED op
  // printed alongside a `CLEAN after revert.` verdict (live-observed 2026-07-08).
  const failedUpdateIds = new Set<string>();
  const applied: {
    logicalId: string;
    displayId: string;
    ok: boolean;
    error?: string;
    hint?: string;
  }[] = [];
  // Per-item transient-retry options (issue #467). `--wait` turns the short default
  // backoff into a deadline-bounded wait so a minutes-long UPDATING window (RSLVR-00705)
  // converges in one command; each item gets its OWN wait budget. `onRetry` prints a
  // per-retry progress line so the wait never looks frozen (see #477's spinner ethos).
  const clock = waitNow ?? Date.now;
  const buildRetryOpts = (displayId: string): RetryOptions => ({
    ...(waitMs !== undefined && { deadlineMs: clock() + waitMs }),
    ...(waitNow && { now: waitNow }),
    ...(waitSleep && { sleep: waitSleep }),
    onRetry: ({ attempt, delayMs, hint }) => {
      const reason = (hint ?? 'transient error').split(' — ')[0];
      const secs = Math.max(1, Math.round(delayMs / 1000));
      console.log(
        style.note(`    ↻ ${displayId}: ${reason} — retry ${attempt} (next in ${secs}s)…`)
      );
    },
  });
  for (const item of plan.items) {
    let r: { ok: boolean; error?: string; hint?: string };
    if (item.kind === 'delete') {
      // physicalId IS the CC identifier (the composite the finding carried); delete it.
      r = await applyRevertDelete(cc, item, item.physicalId, buildRetryOpts(item.displayId));
      if (!r.ok) failedDeleteIds.add(item.logicalId);
    } else if (item.kind === 'sdk') {
      const res = byLogical.get(item.logicalId);
      // Same transient-retry wrapper as the Cloud Control path (issue #467): an SDK
      // writer can also throw a "resource is currently updating" error that settles on
      // a retry, and exhausted retries carry the targeted hint.
      r = await retryTransient(async () => {
        try {
          const writer = resolveSdkWriter(item.resourceType, item.ops);
          if (!writer) throw new Error(`no SDK writer for ${item.resourceType}`);
          // A Cloud-Control-routed nested writer addresses the resource by the composite CC
          // identifier (e.g. AWS::ApiGateway::Stage `RestApiId|StageName`) the READ path
          // resolves — pass it so its GetResource/UpdateResource doesn't ValidationException
          // on the bare physical id. Falls back to the physical id when no adapter applies.
          const identifier =
            CC_IDENTIFIER_ADAPTERS[item.resourceType]?.(item.physicalId, res?.declared ?? {}) ??
            item.physicalId;
          await writer(
            {
              physicalId: item.physicalId,
              identifier,
              declared: res?.declared ?? {},
              region,
              accountId: gathered.desired.accountId,
              resourceType: item.resourceType,
            },
            item.ops
          );
          return { ok: true };
        } catch (e) {
          return { ok: false, error: errorText(e) };
        }
      }, buildRetryOpts(item.displayId));
    } else {
      const res = byLogical.get(item.logicalId);
      const identifier =
        CC_IDENTIFIER_ADAPTERS[item.resourceType]?.(item.physicalId, res?.declared ?? {}) ??
        item.physicalId;
      // Re-attach the live aws:* managed tags onto any /Tags op, so the Cloud Control
      // read-modify-write does not tell the provider to UNtag them (AWS rejects an
      // external write that drops an aws:-prefixed key). Uses the UN-stripped live model
      // kept on the gather (the compare side strips aws:* tags; the write side must not).
      const tagged = tagPreservingOps(item.ops, gathered.liveByLogical.get(item.logicalId));
      // Re-include write-only props the Cloud Control read-modify-write would drop
      // (cdkd #812 — e.g. ECS Service VolumeConfigurations). cc-kind items only.
      const extra = writeOnlyReincludeOps(
        res?.declared,
        gathered.schemas.get(item.resourceType),
        tagged
      );
      // Drop service-echoed empty arrays the service itself rejects on update
      // (#481 — VpcLattice Rule HeaderMatches []). Live-gated + ancestor-aware.
      const strip = rejectedEmptyStripOps(
        item.resourceType,
        [...tagged, ...extra],
        gathered.liveByLogical.get(item.logicalId)
      );
      const combined = [...tagged, ...extra, ...strip];
      const ccItem = { ...item, ops: combined.length > tagged.length ? combined : tagged };
      r = await applyRevertItem(cc, ccItem, identifier, buildRetryOpts(item.displayId));
    }
    applied.push({
      logicalId: item.logicalId,
      displayId: item.displayId,
      ok: r.ok,
      ...(r.error !== undefined && { error: r.error }),
      ...(r.hint !== undefined && { hint: r.hint }),
    });
    if (!r.ok) worst = Math.max(worst, 2);
    // A failed NON-delete op (delete failures already tracked above) — feed the convergence
    // verdict so a FAILED update never rides under a CLEAN summary.
    if (!r.ok && item.kind !== 'delete') failedUpdateIds.add(item.logicalId);
  }
  // Print ONE outcome per resource (a resource that split into a `cc` + `sdk` item
  // produced two results) so a fully reverted resource never prints `reverted:` twice.
  for (const s of summarizeRevertResults(applied)) {
    if (s.ok) {
      console.log(style.ok(`  reverted: ${s.displayId}`));
    } else {
      console.log(style.fail(`  FAILED: ${s.displayId} — ${s.error}`));
      // Transient "resource is mid-update" failure that survived the retries: add a
      // targeted hint so the user knows this is retry-later, not a real failure. When we
      // did NOT already wait (`--wait` off), point at it as the one-command settle path.
      if (s.hint) {
        const suffix =
          waitMs === undefined ? ' (or re-run with --wait to block until it settles)' : '';
        console.log(style.note(`    ↳ ${s.hint}${suffix}`));
      }
    }
  }

  // Re-check convergence — scoped to the resources the revert just touched (R44).
  // A full gatherFindings here re-read the ENTIRE stack (a long silent wait that
  // scaled with stack size, not with the revert); regatherTouched re-reads only
  // plan.items and carries every other finding forward from the original gather.
  const touched = new Set(plan.items.map((i) => i.logicalId));
  console.log(
    '\n' + style.note(`verifying convergence (re-reading ${touched.size} resource(s))...`)
  );
  const reconcile = (findings: Finding[]): Finding[] =>
    applyIgnores(
      applyBaseline(findings, baseline, baselineOpts),
      { stackName, accountId: gathered.desired.accountId, region },
      config
    );
  // regatherTouched drops every `touched` finding (including the synthesized-id `added`
  // deletes) and re-reads only template resources — so a FAILED delete's finding is gone
  // from `post` though the resource still lives. Re-add the failed ones so convergence
  // reflects reality (a successful delete stays dropped = resolved).
  const readdFailedDeletes = (findings: Finding[]): Finding[] =>
    failedDeleteIds.size === 0
      ? findings
      : [...findings, ...gathered.findings.filter((f) => failedDeleteIds.has(f.logicalId))];
  let post = readdFailedDeletes(reconcile(await regatherTouched(gathered, touched, region)));
  if (driftCount(post.filter((f) => touched.has(f.logicalId))) > 0) {
    // A touched resource still reads as drifted. SDK-writer paths (IAM etc.) are
    // eventually consistent — the old slow full re-gather granted propagation time
    // for free; the scoped read must wait deliberately. One retry only.
    await sleep(p.convergeRetryDelayMs ?? CONVERGE_RETRY_DELAY_MS);
    post = readdFailedDeletes(reconcile(await regatherTouched(gathered, touched, region)));
  }
  const remainingDrift = post.filter(isDrift);
  const remaining = remainingDrift.length;
  // #631: a `remove`-style revert the provider SILENTLY IGNORED (the #597 class — an
  // omitted property not applied on UpdateResource; Cognito UserPool DeletionProtection,
  // InternetMonitor Status, …) reports `reverted:` (ok) yet the value PERSISTS. When that
  // value is UNRECORDED undeclared it re-reads as "awaiting a baseline" (not `isDrift`), so
  // it escapes both `remaining` and the verdict, and the stack is falsely called CLEAN. A
  // no-op removal = a `remove` op on a SUCCESSFULLY-applied item whose exact path still
  // re-reads a NON-drift finding carrying the SAME value we tried to remove. Comparing the
  // value (not just presence) is essential: a removal that CONVERGED by AWS re-materializing
  // the DEFAULT (#613 SLO Goal) re-reads a DIFFERENT value / tier and is correctly NOT
  // flagged. (Array-element removes, whose finding path is `[id]`-keyed, are not matched here
  // — the reported cases are all top-level/nested scalar paths.)
  const okIds = new Set(applied.filter((a) => a.ok).map((a) => a.logicalId));
  const preActual = new Map<string, unknown>();
  for (const f of gathered.findings) preActual.set(`${f.logicalId}\0${f.path}`, f.actual);
  const noOpRemovals: { displayId: string; path: string }[] = [];
  for (const item of plan.items) {
    if (item.kind === 'delete' || !okIds.has(item.logicalId)) continue;
    for (const op of item.ops) {
      if (op.op !== 'remove') continue;
      const dotted = op.path.replace(/^\//, '').replace(/\//g, '.');
      const key = `${item.logicalId}\0${dotted}`;
      if (!preActual.has(key)) continue;
      const pre = preActual.get(key);
      const persisted = post.some(
        (f) =>
          f.logicalId === item.logicalId &&
          f.path === dotted &&
          !isDrift(f) &&
          deepEqual(f.actual, pre)
      );
      if (persisted) noOpRemovals.push({ displayId: item.displayId, path: dotted });
    }
  }
  // A touched resource whose verification RE-READ failed (skipped tier — a throttle /
  // transient CC or SDK-override read error) is NOT proof the write landed: a write CC
  // accepted (200) but silently rejected, followed by an unreadable re-read, would
  // otherwise count as zero drift and print "CLEAN". Likewise a FAILED delete of an
  // UNRECORDED `added` resource is re-added to `post` but is excluded from `isDrift`
  // (unrecorded), so it too would read as CLEAN though the resource still lives. Treat
  // both as UNCONFIRMED — never claim convergence we could not verify.
  const unverified = post.filter((f) => touched.has(f.logicalId) && f.tier === 'skipped').length;
  const unconfirmed = unverified + failedDeleteIds.size + failedUpdateIds.size;
  const converged = remaining === 0 && unconfirmed === 0 && noOpRemovals.length === 0;
  // Print the no-op removals FIRST so the "did not converge" verdict below has visible
  // evidence above it, mirroring the FAILED: lines' relationship to the unconfirmed count.
  for (const n of noOpRemovals)
    console.log(
      style.fail(
        `  NOT reverted: ${n.displayId}.${n.path} — removal was a no-op (the provider ignored the omitted property; it needs an explicit default write — see #597 / REVERT_SET_DEFAULT_PATHS)`
      )
    );
  const notConverged = unconfirmed + noOpRemovals.length;
  console.log(
    converged
      ? style.clean(`${stackName}: CLEAN after revert.`)
      : remaining > 0
        ? style.drift(`${stackName}: ${remaining} drift(s) remain.`)
        : style.drift(
            `${stackName}: revert applied, but ${notConverged} value(s) could not be confirmed converged (see above).`
          )
  );
  // unrecorded values are not drift, but silently dropping them here would read
  // as "all good" when a decision is still pending — one dim pointer line (R62).
  const unrecordedLeft = unrecordedCount(post);
  if (unrecordedLeft > 0)
    console.log(
      style.note(
        `  (${unrecordedLeft} unrecorded value(s) still await a baseline — run cdkrd record)`
      )
    );
  // A touched resource we could not re-read leaves the revert UNVERIFIED — point the
  // user at a re-run rather than implying success. (A failed delete already printed its
  // own `FAILED:` line above and bumped the exit to 2 in the apply loop.)
  if (unverified > 0)
    console.log(
      style.note(
        `  (${unverified} resource(s) could not be re-read to verify — re-run cdkrd check to confirm)`
      )
    );
  // Say WHICH drift survived — without this the user must re-run `check` just to
  // learn what didn't converge (R46). A terse id-per-line pointer, not a report;
  // capped so a no-baseline partial revert doesn't re-list 100+ lines (R52).
  for (const line of formatSurvivingDrift(remainingDrift, stackName)) console.log(line);
  // remaining drift, an unverifiable re-read, OR a no-op removal all mean "not confirmed
  // clean" → exit 1 (a failed delete/update already set 2). Never return 0 ("converged")
  // when we could not verify convergence.
  if (remaining > 0 || unverified > 0 || noOpRemovals.length > 0) worst = Math.max(worst, 1);
  return { exit: worst, aborted: false };
}

/**
 * Map a revert outcome back to `check`'s exit code in the interactive flow (R30).
 * An aborted confirm wrote nothing to AWS, so the drift still stands — keep the
 * pre-revert code (always 1 here, the drift branch); otherwise adopt the outcome's
 * exit (0 clean / 1 drift remains / 2 failure). Pure so the asymmetry is unit-tested.
 */
export function resolveInteractiveRevertExit(currentCode: number, outcome: RevertOutcome): number {
  return outcome.aborted ? currentCode : outcome.exit;
}

// ---- interactive choice (pure, unit-tested) ----

export interface Actions {
  record: boolean; // an undeclared drift exists to record
  ignore: boolean; // a declared or undeclared finding exists to ignore (ignore.yaml)
  revert: boolean; // at least one finding is revertable
}

/**
 * Which interactive actions make sense for a stack's (baseline-reconciled) findings:
 *  - Record when there is undeclared drift OR an out-of-band `added` resource (PR4:
 *    record now snapshots added too — it can't fix declared drift, which is
 *    template-vs-reality, unrelated to the baseline);
 *  - Ignore when there is any declared OR undeclared finding (ignore is symmetric
 *    with revert — it is the only in-tool way to accept a declared drift; R120);
 *  - Revert only when buildRevertPlan yields >=1 revertable item (a stack with only
 *    not-revertable findings, e.g. deleted-only, offers no Revert).
 * Pure: no AWS, no prompts. `schemas` feeds the create-only revert gate.
 */
export function availableActions(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  schemas: Map<string, SchemaInfo>,
  removeUnrecorded: boolean
): Actions {
  const recordable = findings.some((f) => f.tier === 'undeclared' || f.tier === 'added');
  // R141: with NO baseline file yet, `record` is ALWAYS offered — it writes the initial
  // baseline (snapshot-complete resources, plus any undeclared entries) so a fresh deploy can
  // be blessed as the day-1 baseline through `check`'s own prompt (no separate `cdkrd record`
  // step). It is offered EVEN when the only drift is a declared/deleted one it cannot itself
  // resolve: establishing the baseline STARTS undeclared watching, which is orthogonal to that
  // drift — the drift keeps being reported until the user reverts/ignores it. Withholding
  // `record` here used to force the user to clear (or permanently `ignore`) the declared drift
  // before they could even begin watching undeclared state, defeating the tool's core value.
  // `buildResolveOptions` worded the establish option honestly for that case ("the declared
  // drift stays reported"), so it no longer reads as "all done". Once a baseline exists,
  // `record` is offered only when there is undeclared/added state to snapshot.
  const record = recordable || baseline === undefined;
  const ignore = findings.some(
    (f) => f.tier === 'declared' || f.tier === 'undeclared' || f.tier === 'added'
  );
  const plan = buildRevertPlan(findings, baseline, { removeUnrecorded, schemas });
  return { record, ignore, revert: plan.items.length > 0 };
}

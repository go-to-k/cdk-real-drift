// check's interactive after-report resolution (R28, extended R121). After `check`
// reports drift in a TTY, it offers to resolve it inline instead of making the user
// re-run a separate verb. The top-level choice is:
//   Record / Revert / Ignore  — ONE action; its multiselect then narrows which findings
//                                (and which ops) it applies to
//   Decide per finding         — assign a DIFFERENT action PER finding (the picker)
//   Nothing                    — leave it (default)
// Each bulk option appears only when >=1 finding can take that action; "Decide per
// finding" appears only when >1 finding is decidable (with one, the bulk option already
// IS per-finding). All paths route through the SAME stack-actions code as the standalone
// verbs, so the interactive flow and `cdkrd record/ignore/revert` can never diverge.
import { isCancel, select } from '@clack/prompts';
import {
  applyBaseline,
  type ApplyBaselineOptions,
  type BaselineFile,
  buildRecorded,
  constructPathsByLogical,
  declaredKeysByLogical,
  loadBaseline,
  physicalIdsByLogical,
  recordedKey,
} from '../baseline/baseline-file.js';
import { applyIgnores, type CdkrdConfig, loadConfig } from '../config/config-file.js';
import { withinStackPath } from '../construct-path.js';
import type { Desired } from '../desired/template-adapter.js';
import type { Finding, SchemaInfo } from '../types.js';
import {
  actionPicker,
  applicableActions,
  groupByAction,
  summarizeChoices,
} from './action-picker.js';
import {
  type Actions,
  availableActions,
  ignoreStack,
  includeUnrecordedRemovals,
  recordStack,
  revertStack,
} from './stack-actions.js';

export interface ResolveParams {
  stackName: string;
  region: string;
  desired: Desired;
  findings: Finding[]; // RAW gather findings (pre-baseline) — what the stack-actions expect
  reconciled: Finding[]; // baseline + ignore applied (exactly what the report showed)
  baseline: BaselineFile | undefined;
  schemas: Map<string, SchemaInfo>;
  liveByLogical: Map<string, Record<string, unknown>>; // logicalId -> live model, for tag-preserving revert
  config: CdkrdConfig;
  code: number; // pre-prompt exit (1 = drift, else 0)
  yes: boolean;
  removeUnrecorded: boolean;
  verbose: boolean;
  positionPrefix?: string; // `[2/3] ` in a multi-stack run, '' otherwise (issue #539)
}

/**
 * Closing note after an interactive record inside `check` (R52). A PARTIAL record used
 * to end with `baseline written: ...` and a silent failure-looking exit. State plainly
 * what remains; check is report-only (exit 0 on drift) unless --fail, and the interactive
 * prompts never fire in fail mode, so this note never coexists with a drift exit. Pure +
 * exported for tests.
 */
export function postRecordNote(remainingUndeclared: number, remainingDeclared: number): string {
  if (remainingDeclared > 0) {
    const alsoUndeclared =
      remainingUndeclared > 0
        ? ` ${remainingUndeclared} unrecorded value(s) also stay reported.`
        : '';
    // resolutions span the tiers: declared → fix the code / revert / ignore; deleted →
    // cdk deploy; a changed-since-record added resource → re-record (accept) / revert /
    // ignore. "fix the code, or revert / ignore them" covers all without listing each.
    return `record succeeded, but ${remainingDeclared} declared/deleted/added drift(s) remain un-addressed (fix the code, or revert / ignore them).${alsoUndeclared}`;
  }
  if (remainingUndeclared > 0)
    return `record succeeded — ${remainingUndeclared} unrecorded value(s) stay reported from the next check on.`;
  return 'stack is now CLEAN.';
}

// Identity shared by raw and reconciled findings (one property of one resource).
// Includes `attributeKey` so the ELB attribute-bag findings — which all share one
// logicalId+path (`LoadBalancerAttributes`) and differ only by attributeKey — get
// DISTINCT keys. Without it, choosing `revert` for one bag attribute and `skip` for
// another in the per-finding picker collapses both to one key, and the
// `p.findings.filter(keyOf ∈ revertKeys)` re-admit in perFinding then reverts the
// SKIPPED attribute too — an unintended AWS write. Mirrors revertOpKey in
// stack-actions.ts (same fix, same reason). Exported for the collision unit test.
export const keyOf = (f: Finding): string =>
  `${f.logicalId}::${f.path}${f.attributeKey !== undefined ? `[${f.attributeKey}]` : ''}`;

// The tier tag shown on each picker row. Anchors the vocabulary to its source so
// "declared" is never misread as the .cdkrd baseline: CFn-declared = in the deployed
// CloudFormation template; undeclared = live-only (not in the template); `unrecorded`
// is the separate baseline-file axis.
const tierTag = (f: Finding): string =>
  f.tier === 'declared'
    ? 'CFn-declared'
    : f.tier === 'added'
      ? `added resource · live-only${f.unrecorded ? ' · unrecorded' : ''}`
      : `CFn-undeclared · live-only${f.unrecorded ? ' · unrecorded' : ''}`;

// Show `attributeKey` (e.g. `LoadBalancerAttributes[idle_timeout.timeout_seconds]`)
// so ELB attribute-bag rows are distinguishable in the picker — without it the bag's
// rows render identically and the user can't tell which attribute they're deciding
// on (mirrors report.ts's `path[attributeKey]`).
export const pickerLabel = (f: Finding, stackName = ''): string => {
  const id = f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId;
  return `${id}${f.path ? `.${f.path}` : ''}${
    f.attributeKey !== undefined ? `[${f.attributeKey}]` : ''
  }  (${tierTag(f)})`;
};

// Mirrors report.ts's R96 fold: a NESTED unrecorded undeclared value (a live-only sub-key
// inside a declared object) collapses out of the report body by default — the live model
// carries many such sub-keys, so listing them all re-floods the first run. The interactive
// pickers mirror that fold: they default to the SHOWN findings and gate the folded ones
// behind an explicit "include folded" choice, so a picker never silently balloons from the
// report's small drift count to a wall of nested values (the 3-vs-26 surprise) — and, for
// ignore, never blind-ignores values the user never saw. `--verbose` means the report
// already listed them in full, so nothing is folded. A free-form map key (freeFormKey) is
// NEVER folded — the report shows it, so the picker itemizes it too. Pure + exported for tests.
export const isFoldedFinding = (f: Finding, verbose: boolean): boolean =>
  !verbose && f.unrecorded === true && f.nested === true && !f.freeFormKey;

// The two scope rows shown when check folded undeclared inventory out of the report:
// decide on just what was shown, or pull the folded values in too. Pure + exported.
export function buildScopeOptions(
  shownCount: number,
  foldedCount: number
): { value: string; label: string }[] {
  return [
    { value: 'shown', label: `Just the ${shownCount} shown in the report` },
    {
      value: 'all',
      label: `Also the ${foldedCount} folded undeclared value(s) (${shownCount + foldedCount} total)`,
    },
  ];
}

/**
 * Ask which findings the ignore / per-finding picker should cover when check folded
 * undeclared inventory out of the report body. Returns 'shown' (default) or 'all', or
 * `null` on cancel (→ back to the menu). No prompt — and 'all' returned — when there is no
 * meaningful split: nothing folded, nothing else shown, or `--yes` (the caller asked not
 * to be prompted, so it gets the full set, matching the pre-gate `--yes` behaviour). The
 * `--yes` case never reaches the AWS-mutating revert through here (revert has no gate).
 */
async function chooseScope(
  stackName: string,
  shownCount: number,
  foldedCount: number,
  yes: boolean
): Promise<'shown' | 'all' | null> {
  if (yes || foldedCount === 0 || shownCount === 0) return 'all';
  const choice = await select({
    message: `${stackName}: the report folded ${foldedCount} undeclared value(s) — which to decide on?`,
    options: buildScopeOptions(shownCount, foldedCount),
    initialValue: 'shown',
  });
  if (isCancel(choice)) return null;
  return choice as 'shown' | 'all';
}

// declared/constructPath/physicalId maps for applyBaseline. The physicalId + the
// constructPath are what a synthesized "baseline value removed since record" finding
// needs (physicalId so a later in-menu revert can act on it, constructPath so an
// ignore rule matches); shared so every re-reconciliation here matches stack-actions.
const baselineOpts = (p: ResolveParams): ApplyBaselineOptions => ({
  declaredByLogical: declaredKeysByLogical(p.desired.resources),
  constructPathByLogical: constructPathsByLogical(p.desired.resources),
  physicalIdByLogical: physicalIdsByLogical(p.desired.resources),
  // #675: fold recorded entries whose resource was removed from the template.
  allLogicalIds: p.desired.resources.map((r) => r.logicalId),
});

/**
 * Re-evaluate check's exit WITHOUT re-reading AWS: reload the (possibly just-written)
 * baseline + config and re-apply them to the original gather findings. Declared/deleted
 * drift that the user did not resolve keeps exit 1; ignored findings now drop to the
 * `ignored` tier (config reloaded) and reverted findings are excluded as resolved.
 * Undeclared/unrecorded values never set the exit (R60/R52). TTY-only, so no CI contract.
 */
async function recomputeExit(p: ResolveParams, resolvedKeys: Set<string>): Promise<number> {
  const nb = await loadBaseline(p.stackName, p.desired.accountId, p.region);
  const nc = await loadConfig();
  const reEval = applyIgnores(
    applyBaseline(p.findings, nb, baselineOpts(p)),
    { stackName: p.stackName, accountId: p.desired.accountId, region: p.region },
    nc
  );
  const remainingDeclared = reEval.filter(
    (f) =>
      // PR4: an UNRECORDED added resource is inventory, not drift (like an unrecorded
      // undeclared value), so it must NOT keep exit 1 — only a recorded-but-changed
      // added resource counts. declared/deleted are never unrecorded.
      (f.tier === 'declared' || f.tier === 'deleted' || (f.tier === 'added' && !f.unrecorded)) &&
      !resolvedKeys.has(keyOf(f))
  ).length;
  return remainingDeclared > 0 ? 1 : 0;
}

/**
 * Outcome of a sub-action (one menu choice carried out).
 *  - `exit`: the exit contribution after the action.
 *  - `awsMutated`: whether the action wrote to AWS (a revert ran). A NON-AWS action
 *    (record/ignore) only writes the local baseline/config, so its effect is fully
 *    re-derivable by reloading those files — the chain loop re-reconciles and re-shows
 *    the menu so leftover drift it could not touch (e.g. a declared drift after Record)
 *    is not a dead-end. An AWS-mutating action is TERMINAL: revert already re-checked
 *    convergence against live AWS and returned its exit, and we deliberately do NOT
 *    re-read AWS in the loop, so re-deriving from the (now stale) findings would be wrong.
 * A `null` sub-action result means its prompt was cancelled (nothing happened) → re-show
 * the SAME menu.
 */
interface SubResult {
  exit: number;
  awsMutated: boolean;
}

/**
 * How to word the Record option (its action is always the same — snapshot undeclared into
 * the baseline, R141-establishing the file if absent — but the label must describe what it
 * actually does HERE so it never over-promises):
 *  - 'snapshot'          — there ARE undeclared/added values to record (baseline present or not).
 *  - 'establish'         — nothing undeclared to record and no baseline yet, on an otherwise
 *                          CLEAN stack: Record just establishes the day-1 baseline (marks reviewed).
 *  - 'establish-drift'   — nothing undeclared to record and no baseline yet, but a DECLARED drift
 *                          coexists: Record establishes the baseline + STARTS undeclared watching,
 *                          while that drift stays reported (revert/ignore it separately).
 *  - 'establish-deleted' — same, but the coexisting drift is a DELETED declared resource: it stays
 *                          reported and is restored by re-deploying (NOT revert/ignore), so the
 *                          hint differs. Only used when there is no declared drift to take priority.
 */
export type RecordLabelKind = 'snapshot' | 'establish' | 'establish-drift' | 'establish-deleted';

function recordOptionLabel(kind: RecordLabelKind): string {
  switch (kind) {
    case 'establish':
      return 'Record current state as the .cdkrd baseline (marks this stack reviewed)';
    case 'establish-drift':
      return 'Record current state as the .cdkrd baseline (start watching undeclared now — the declared drift stays reported; revert/ignore it separately)';
    case 'establish-deleted':
      return 'Record current state as the .cdkrd baseline (start watching undeclared now — the deleted-resource drift stays reported; re-deploy to restore it)';
    default:
      return 'Record undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)';
  }
}

/**
 * Build the top-menu options for the current action surface (R133). Nothing is FIRST so
 * the safe no-op is the top row AND the default cursor — Enter is a harmless exit, never
 * an accidental write. "Decide per finding" appears only when >1 finding is decidable
 * (with one, a bulk option already IS per-finding). Pure + exported for tests.
 */
export function buildResolveOptions(
  actions: Actions,
  decidableCount: number,
  recordLabel: RecordLabelKind = 'snapshot'
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [
    { value: 'nothing', label: 'Nothing (decide later)' },
  ];
  if (actions.record) options.push({ value: 'record-all', label: recordOptionLabel(recordLabel) });
  if (actions.revert)
    options.push({ value: 'revert-all', label: 'Revert — write the desired values back to AWS' });
  if (actions.ignore)
    options.push({
      value: 'ignore-all',
      label: 'Ignore — stop reporting it (writes .cdkrd/ignore.yaml)',
    });
  // The bulk options above each apply ONE action (the picker then narrows WHICH findings,
  // and which ops within a finding); "Decide per finding" is the only path that assigns a
  // DIFFERENT action to each finding — say that, so the contrast is explicit (the values
  // are 'revert-all'/'ignore-all' for back-compat, but the labels no longer say "all"
  // since revert's picker starts fully UNSELECTED, R137).
  if (decidableCount > 1)
    options.push({
      value: 'per-finding',
      label: 'Decide per finding — assign a different action to each',
    });
  return options;
}

/** The top-menu prompt, worded by the remaining exit state (drift vs unrecorded-only vs
 *  R141 no-baseline establish). `prefix` carries the `[2/3] ` multi-stack position cue
 *  (issue #539) — empty for a lone stack. Pure + exported. */
export function resolveMenuMessage(
  stackName: string,
  code: number,
  establishOnly = false,
  prefix = ''
): string {
  if (establishOnly)
    return `${prefix}${stackName}: no .cdkrd baseline yet — record the current state as your baseline?`;
  return code === 1
    ? `${prefix}${stackName}: drift found — what do you want to do?`
    : `${prefix}${stackName}: potential drift found (live-only, no baseline yet) — what do you want to do?`;
}

export async function resolveInteractively(p: ResolveParams): Promise<number> {
  const opts = baselineOpts(p);
  // Whether undeclared REMOVE ops belong in a revert plan — true in a gated TTY prompt.
  const includeRemovals = includeUnrecordedRemovals(p.removeUnrecorded, true, p.yes);
  // Chain state: a record/ignore mutates only local files, so after one runs we reload
  // the baseline + config and RE-RECONCILE the raw findings — the menu re-shows with the
  // leftover, addressable drift (R133). reconciled/baseline/config advance each iteration;
  // code carries the exit forward.
  let reconciled = p.reconciled;
  let baseline = p.baseline;
  let config = p.config;
  let code = p.code;

  // Loop so a CANCELLED sub-prompt (Esc) returns to this menu (a "back" affordance) AND so
  // a COMPLETED non-AWS action re-shows the menu for any drift it could not resolve. Esc /
  // Nothing at THIS top menu exits with the current code; the menu stops appearing once no
  // action applies (e.g. the stack is clean, or only an AWS-mutating action ran).
  while (true) {
    const actions = availableActions(reconciled, baseline, p.schemas, includeRemovals);
    if (!actions.record && !actions.ignore && !actions.revert) return code;
    const decidable = reconciled.filter((f) => applicableActions(f).length > 0);
    // R141: nothing to act on, but no baseline yet → Record establishes the day-1 baseline.
    // The only available action is `record` and there are no actionable findings to decide.
    const establishOnly = baseline === undefined && decidable.length === 0;
    // Word the Record option for what it does HERE. With undeclared/added to snapshot it is a
    // plain snapshot; with none and no baseline it establishes the baseline — and when a hard
    // drift coexists (R141 relaxed), say so honestly so "Record" never reads as "all done" next
    // to a drift it does not itself resolve. A DECLARED drift takes priority (its hint points at
    // revert/ignore); a DELETED declared resource gets its own hint (re-deploy to restore — it
    // is not revert/ignore-able from this menu).
    const recordable = reconciled.some((f) => f.tier === 'undeclared' || f.tier === 'added');
    const declaredDrift = reconciled.some((f) => f.tier === 'declared');
    const deletedDrift = reconciled.some((f) => f.tier === 'deleted');
    const recordLabel: RecordLabelKind = recordable
      ? 'snapshot'
      : declaredDrift
        ? 'establish-drift'
        : deletedDrift
          ? 'establish-deleted'
          : 'establish';
    const options = buildResolveOptions(actions, decidable.length, recordLabel);

    const choice = await select({
      message: resolveMenuMessage(p.stackName, code, establishOnly, p.positionPrefix ?? ''),
      options,
      initialValue: 'nothing',
    });
    if (isCancel(choice) || choice === 'nothing') return code;

    const cur: ResolveParams = { ...p, reconciled, baseline, config, code };
    let result: SubResult | null;
    if (choice === 'record-all') result = await recordAll(cur);
    else if (choice === 'ignore-all') result = await ignoreAll(cur);
    else if (choice === 'revert-all') result = await revertAll(cur);
    else if (choice === 'per-finding') result = await perFinding(cur, decidable);
    else result = { exit: code, awsMutated: false };

    if (result === null) continue; // sub-prompt cancelled → re-show the same menu
    code = result.exit;
    // An AWS-mutating action is terminal: convergence was already verified against live
    // AWS inside revert, and we never re-read AWS here, so re-deriving from stale findings
    // would be wrong. A non-AWS action (record/ignore) is fully re-derivable — reload the
    // local files, re-reconcile, and loop so leftover drift re-surfaces in the menu.
    if (result.awsMutated) return code;
    baseline = await loadBaseline(p.stackName, p.desired.accountId, p.region);
    config = await loadConfig();
    reconciled = applyIgnores(
      applyBaseline(p.findings, baseline, opts),
      { stackName: p.stackName, accountId: p.desired.accountId, region: p.region },
      config
    );
  }
}

// record snapshots UNDECLARED + out-of-band ADDED resources (PR4); recordStack emits the
// "declared/deleted NOT approved" scope note after the write (R117), so this path warns
// consistently with `cdkrd record`.
async function recordAll(p: ResolveParams): Promise<SubResult | null> {
  const result = await recordStack({
    stackName: p.stackName,
    region: p.region,
    desired: p.desired,
    findings: applyIgnores(
      p.findings,
      { stackName: p.stackName, accountId: p.desired.accountId, region: p.region },
      p.config
    ),
    yes: p.yes,
    interactive: true,
    expandNested: p.verbose, // --show-all skips the interactive flow, so only --verbose expands here
  });
  // !wrote in this interactive path means the multiselect was cancelled (nothing
  // written) — signal "back to the menu" rather than exit.
  if (!result.wrote) return null;
  // R52: a successful interactive record is a SUCCESS for THIS run — unselected
  // undeclared values surface from the next check on, not as a failure now. Declared/
  // deleted drift is outside record's reach and keeps exit 1. Say what remains plainly.
  const nb = await loadBaseline(p.stackName, p.desired.accountId, p.region);
  const reEval = applyIgnores(
    applyBaseline(p.findings, nb, baselineOpts(p)),
    { stackName: p.stackName, accountId: p.desired.accountId, region: p.region },
    p.config
  );
  const remainingDeclared = reEval.filter(
    // PR4: a recorded-but-CHANGED added resource is still drift and keeps exit 1; an
    // UNRECORDED added one (not snapshotted) is inventory, counted with the undeclared
    // bucket below. declared/deleted are always drift, never recordable.
    (f) => f.tier === 'declared' || f.tier === 'deleted' || (f.tier === 'added' && !f.unrecorded)
  ).length;
  const remainingUndeclared = reEval.filter(
    (f) => f.tier === 'undeclared' || (f.tier === 'added' && f.unrecorded)
  ).length;
  console.error(`note: ${p.stackName}: ${postRecordNote(remainingUndeclared, remainingDeclared)}`);
  return { exit: remainingDeclared > 0 ? 1 : 0, awsMutated: false };
}

async function ignoreAll(p: ResolveParams): Promise<SubResult | null> {
  // ignoreStack filters to the ignorable tiers (declared / undeclared / added) and shows
  // its own multiselect (default NONE selected, R137) when !yes, mirroring `cdkrd ignore`.
  // Pre-split here so the folded undeclared inventory is gated behind chooseScope: the
  // picker defaults to the report's SHOWN findings, not a wall of nested values.
  const ignorable = p.reconciled.filter(
    (f) => f.tier === 'declared' || f.tier === 'undeclared' || f.tier === 'added'
  );
  const foldedCount = ignorable.filter((f) => isFoldedFinding(f, p.verbose)).length;
  const scope = await chooseScope(p.stackName, ignorable.length - foldedCount, foldedCount, p.yes);
  if (scope === null) return null; // scope prompt cancelled → back to the menu
  const findings =
    scope === 'all' ? ignorable : ignorable.filter((f) => !isFoldedFinding(f, p.verbose));
  const result = await ignoreStack({
    stackName: p.stackName,
    findings,
    yes: p.yes,
    interactive: true,
  });
  // reconciled findings are all not-yet-ignored, so a completed run always writes a new
  // rule; !wrote means the multiselect was cancelled → back to the menu.
  return result.wrote ? { exit: await recomputeExit(p, new Set()), awsMutated: false } : null;
}

async function revertAll(p: ResolveParams): Promise<SubResult | null> {
  const outcome = await revertStack({
    stackName: p.stackName,
    region: p.region,
    gathered: {
      desired: p.desired,
      findings: p.findings,
      schemas: p.schemas,
      liveByLogical: p.liveByLogical,
    },
    baseline: p.baseline,
    config: p.config,
    dryRun: false,
    // NEVER inherit --yes here. `check` is the read-only verb; reaching a revert
    // through its interactive menu must still show the "this WRITES to AWS" confirm.
    // `yes:true` would skip BOTH the op-multiselect AND that confirm (the whole block
    // in revertStack is `if (!yes)`), so `check --yes` + "Revert all" would mutate AWS
    // with no prompt. The standalone `cdkrd revert --yes` bypass is intended and goes
    // through revert.ts directly, not this path.
    yes: false,
    removeUnrecorded: p.removeUnrecorded,
    verbose: p.verbose,
    interactive: true,
  });
  // R30: an aborted confirm wrote nothing — signal "back to the menu" (the drift still
  // stands; the caller keeps the pre-prompt code if the user then exits).
  return outcome.aborted ? null : { exit: outcome.exit, awsMutated: true };
}

async function perFinding(p: ResolveParams, decidable: Finding[]): Promise<SubResult | null> {
  // Gate the folded undeclared inventory the same way ignore does: default the picker to
  // the report's SHOWN findings, ask before pulling the folded nested values in.
  const foldedCount = decidable.filter((f) => isFoldedFinding(f, p.verbose)).length;
  const scope = await chooseScope(p.stackName, decidable.length - foldedCount, foldedCount, p.yes);
  if (scope === null) return null; // scope prompt cancelled → back to the menu
  const scoped =
    scope === 'all' ? decidable : decidable.filter((f) => !isFoldedFinding(f, p.verbose));
  const rows = scoped.map((f) => ({
    label: pickerLabel(f, p.stackName),
    applicable: applicableActions(f),
  }));
  const chosen = await actionPicker(`${p.stackName}: assign an action to each finding`, rows);
  if (chosen === undefined) return null; // picker cancelled (Esc) → back to the menu
  const groups = groupByAction(scoped, chosen);
  if (groups.record.length + groups.ignore.length + groups.revert.length === 0)
    return { exit: p.code, awsMutated: false };

  // record: the picker already chose which undeclared values — recordStack records
  // exactly those (preselectedKeys) while still auto-keeping the existing baseline.
  if (groups.record.length > 0) {
    const preselectedKeys = new Set(buildRecorded(groups.record).map(recordedKey));
    await recordStack({
      stackName: p.stackName,
      region: p.region,
      desired: p.desired,
      findings: applyIgnores(
        p.findings,
        { stackName: p.stackName, accountId: p.desired.accountId, region: p.region },
        p.config
      ),
      yes: p.yes,
      interactive: true,
      preselectedKeys,
    });
  }
  // ignore: write rules for exactly the chosen findings (yes:true skips ignoreStack's
  // own multiselect — the picker IS the selection). addIgnoreRules unions, no data loss.
  if (groups.ignore.length > 0) {
    await ignoreStack({
      stackName: p.stackName,
      findings: groups.ignore,
      yes: true,
      interactive: true,
    });
  }
  // revert (AWS, last): pass ONLY the chosen findings; autoSelectAll skips the op
  // multiselect (already chosen) but keeps the AWS-write confirm.
  let revertResolved = new Set<string>();
  let revertExit = 0;
  if (groups.revert.length > 0) {
    const revertKeys = new Set(groups.revert.map(keyOf));
    const outcome = await revertStack({
      stackName: p.stackName,
      region: p.region,
      gathered: {
        desired: p.desired,
        findings: p.findings.filter((f) => revertKeys.has(keyOf(f))),
        schemas: p.schemas,
        liveByLogical: p.liveByLogical,
      },
      baseline: p.baseline,
      config: p.config,
      dryRun: false,
      // NEVER inherit --yes (see revertAll): the read-only `check` verb must still
      // confirm an AWS write. autoSelectAll skips the op-multiselect (the picker already
      // chose), but the "this WRITES to AWS" confirm must fire — which only happens when
      // yes is false (the confirm lives inside `if (!yes)` in revertStack).
      yes: false,
      removeUnrecorded: p.removeUnrecorded,
      verbose: p.verbose,
      interactive: true,
      autoSelectAll: true,
    });
    if (!outcome.aborted) {
      revertResolved = revertKeys; // converged-or-attempted; outcome.exit folds in non-convergence
      revertExit = outcome.exit;
    }
  }
  console.error(
    `note: ${p.stackName}: per-finding decisions applied (${summarizeChoices(chosen)}).`
  );
  return {
    exit: Math.max(await recomputeExit(p, revertResolved), revertExit),
    // per-finding is terminal only if it actually wrote to AWS (a revert ran); a
    // record/ignore-only per-finding pass is re-derivable, so the menu re-shows.
    awsMutated: groups.revert.length > 0,
  };
}

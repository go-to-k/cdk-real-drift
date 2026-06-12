// Per-stack accept / revert actions, shared by the standalone `accept` / `revert`
// commands AND `check`'s interactive after-drift prompt (R28). Extracting them keeps
// the interactive flow and the single-verb commands behaviourally identical: both go
// through exactly the same accept / plan / apply / converge code.
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { confirm, isCancel, multiselect } from '@clack/prompts';
import {
  acceptedKey,
  applyBaseline,
  type BaselineFile,
  buildAccepted,
  declaredKeysByLogical,
  loadBaseline,
  selectAccepted,
  splitAcceptedByBaseline,
  writeBaseline,
} from '../baseline/baseline-file.js';
import { applyIgnores, type CdkrdConfig } from '../config/config-file.js';
import { style } from '../report/style.js';
import { applyRevertItem } from '../revert/apply.js';
import { buildRevertPlan, type RevertPlan } from '../revert/plan.js';
import { resolveSdkWriter } from '../revert/writers.js';
import type { Finding, SchemaInfo } from '../types.js';
import { type Desired } from '../desired/template-adapter.js';
import { type GatherResult, regatherTouched } from './gather.js';

const isDrift = (f: Finding): boolean =>
  f.tier === 'deleted' || f.tier === 'declared' || f.tier === 'undeclared';
const driftCount = (findings: Finding[]): number => findings.filter(isDrift).length;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Message for accept's multiselect. clack renders NO key hints by default (they
 * only appear inside the required-validation error), so the keys users need —
 * verified against @clack/core: space toggles, `a` toggles all, `i` inverts,
 * enter confirms — are spelled out on a dim second line (R49). Pure + exported
 * so the wording is unit-tested.
 */
export function acceptSelectMessage(stackName: string): string {
  return (
    `${stackName}: select undeclared value(s) to accept (unselected stay reported)\n` +
    style.infoTier('space = toggle · a = toggle all · i = invert · enter = confirm')
  );
}

// ---- accept ----

export interface AcceptStackParams {
  stackName: string;
  region: string;
  desired: Desired;
  findings: Finding[]; // the gather's findings (undeclared still present, pre-baseline)
  yes: boolean;
  interactive: boolean; // whether the multiselect decision prompt may be shown (TTY && !--no-interactive)
}

/**
 * Outcome of a per-stack accept.
 *  - `wrote`: a baseline file was written.
 *  - `refused`: true ONLY when a decision was required (undeclared values to accept)
 *    but the run is non-interactive and `--yes` was not passed — accept refuses
 *    rather than accepting everything by default (R38). A user-cancelled multiselect
 *    is `{ wrote:false, refused:false }`, not a refusal.
 */
export interface AcceptResult {
  wrote: boolean;
  refused: boolean;
}

/**
 * Record the current undeclared state into the baseline file. In an interactive run
 * (no --yes) the user picks WHICH undeclared values to accept (selective accept, R14).
 * When an existing baseline is present the multiselect shows only the DELTA from it
 * (new/changed); already-accepted unchanged values are auto-kept and surfaced with a
 * note (R39). An empty FINAL set is confirmed first (R19). Non-interactively
 * (--no-interactive or non-TTY/CI), the multiselect is a required DECISION: with
 * undeclared values present and no --yes, accept refuses (exit 2) instead of accepting
 * all (R38). When there is nothing to decide (no undeclared values) the baseline is
 * written regardless. (Same flow whether reached via `cdkrd accept` or check's
 * interactive prompt — neither re-gathers.)
 */
export async function acceptStack(p: AcceptStackParams): Promise<AcceptResult> {
  const { stackName, region, desired, findings, yes, interactive } = p;
  const existing = await loadBaseline(stackName, desired.accountId, region);
  if (!yes && existing)
    console.error(
      `note: ${stackName}: overwriting existing baseline (it is git-tracked; review the diff). Pass --yes to silence.`
    );
  let accepted = buildAccepted(findings);
  let refreshedOnly = false; // true when only unchanged values remained (no delta to decide)
  if (!yes && accepted.length > 0) {
    // A decision is required (which undeclared values to accept). Non-interactively
    // we refuse rather than implicitly accept ALL of them (R38).
    if (!interactive) {
      console.error(
        `error: accept needs a decision — pass --yes to accept ALL undeclared values, or run interactively`
      );
      return { wrote: false, refused: true };
    }
    // Only make the human decide on the DELTA from the existing baseline: already-accepted
    // unchanged values are auto-kept (re-confirming a 50-item snapshot every time is wrong,
    // R39). With no baseline the split returns everything as `changed` (the true first accept).
    const { unchanged, changed } = splitAcceptedByBaseline(accepted, existing);
    if (unchanged.length > 0)
      console.error(
        `note: ${stackName}: keeping ${unchanged.length} already-accepted unchanged value(s)`
      );
    if (changed.length === 0) {
      // Nothing new to decide — just refresh the baseline (re-snapshot the unchanged set).
      accepted = unchanged;
      refreshedOnly = true;
    } else {
      const picked = await multiselect({
        message: acceptSelectMessage(stackName),
        options: changed.map((e) => ({ value: acceptedKey(e), label: `${e.logicalId}.${e.path}` })),
        initialValues: changed.map((e) => acceptedKey(e)), // default = all selected
        required: false,
      });
      if (isCancel(picked)) {
        console.error(`note: ${stackName}: accept cancelled — baseline unchanged`);
        return { wrote: false, refused: false };
      }
      const selectedChanged = selectAccepted(findings, new Set(picked));
      accepted = [...unchanged, ...selectedChanged]; // auto-kept unchanged + the user's picks
      // The FINAL written set being empty (no unchanged + nothing picked) writes an EMPTY
      // baseline, which CREATES the file and lifts R2's no-baseline revert guard — `revert`
      // would then plan REMOVAL of all undeclared drift. Confirm that consequence (R19).
      if (accepted.length === 0) {
        const proceed = await confirm({
          message: `${stackName}: accept nothing? This writes an EMPTY baseline — \`cdkrd revert\` will then plan REMOVAL of ALL undeclared drift on this stack.`,
          initialValue: false,
        });
        if (isCancel(proceed) || !proceed) {
          console.error(`note: ${stackName}: accept cancelled — baseline unchanged`);
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
    accepted
  );
  if (refreshedOnly)
    console.log(
      style.ok(
        `${stackName}: nothing new to accept — baseline refreshed (${count} unchanged value(s))`
      )
    );
  else console.log(style.ok(`baseline written: ${path} (${count} undeclared value(s) accepted)`));
  return { wrote: true, refused: false };
}

// ---- revert ----

export interface PlanDisplayOptions {
  verbose?: boolean; // expand the NOT-revertable per-reason summary to the full per-finding list
  noBaselineGuidance?: boolean; // no baseline + undeclared drift → lead with the accept-first route
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
  const lines: string[] = [`\n=== cdkrd revert: ${stackName} (${region}) ===`];
  if (opts.noBaselineGuidance) {
    lines.push(
      `\nnote: ${stackName} has no baseline — undeclared drift has no revert target.`,
      '      Run `cdkrd check` or `cdkrd accept` to record a baseline first.'
    );
  }
  for (const item of plan.items) {
    lines.push(`\n  ${item.displayId} (${item.resourceType})`);
    for (const op of item.ops) lines.push(`    - ${op.human}`);
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
  config: CdkrdConfig; // .cdkrd/config.json ignore rules (ignored findings drop out of the plan)
  dryRun: boolean;
  yes: boolean;
  removeUnaccepted: boolean;
  verbose: boolean; // expand the NOT-revertable summary to the full list
  interactive: boolean; // whether the confirm prompt may be shown (TTY && !--no-interactive)
  // Delay before the single convergence re-read retry (SDK-writer paths can lag
  // behind their API response — eventual consistency). Overridable so unit tests
  // don't sleep for real.
  convergeRetryDelayMs?: number;
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
export async function revertStack(p: RevertStackParams): Promise<RevertOutcome> {
  const {
    stackName,
    region,
    gathered,
    baseline,
    config,
    dryRun,
    yes,
    removeUnaccepted,
    verbose,
    interactive,
  } = p;
  let worst = 0;
  const declaredByLogical = declaredKeysByLogical(gathered.desired.resources);
  const drifted = applyIgnores(
    applyBaseline(gathered.findings, baseline, { declaredByLogical, warn: console.error }),
    stackName,
    config
  );
  const plan = buildRevertPlan(drifted, baseline, { removeUnaccepted, schemas: gathered.schemas });

  if (plan.items.length === 0 && plan.notRevertable.length === 0) {
    console.log(style.clean(`${stackName} (${region}): no drift to revert.`));
    return { exit: 0, aborted: false };
  }
  printPlan(stackName, region, plan, {
    verbose,
    // Only when the no-baseline guard actually fires: with --remove-unaccepted the
    // plan REMOVES undeclared drift, so a "no revert target — accept first" note
    // would contradict the plan printed right below it (R35 review).
    noBaselineGuidance:
      baseline === undefined && !removeUnaccepted && drifted.some((f) => f.tier === 'undeclared'),
  });
  if (plan.items.length === 0) {
    // Drift exists but none of it is revertable (R35). That is NOT the clean
    // "no drift to revert" case — the drift still stands, so exit 1 (the same
    // "drift remains" semantics as a post-apply non-convergence; not a usage error).
    console.log('\n' + style.drift(`nothing revertable — ${driftCount(drifted)} drift(s) remain.`));
    return { exit: 1, aborted: false };
  }

  const opCount = plan.items.reduce((n, i) => n + i.ops.length, 0);
  if (dryRun) {
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
    const ok = await confirm({
      message: `Apply ${opCount} revert op(s) to ${stackName}? This WRITES to AWS.`,
    });
    if (isCancel(ok) || !ok) {
      console.log(style.infoTier('aborted.'));
      return { exit: 0, aborted: true };
    }
  }

  const cc = new CloudControlClient({ region });
  const byLogical = new Map(gathered.desired.resources.map((res) => [res.logicalId, res]));
  for (const item of plan.items) {
    let r: { ok: boolean; error?: string };
    if (item.kind === 'sdk') {
      const res = byLogical.get(item.logicalId);
      try {
        const writer = resolveSdkWriter(item.resourceType, item.ops);
        if (!writer) throw new Error(`no SDK writer for ${item.resourceType}`);
        await writer(
          {
            physicalId: item.physicalId,
            declared: res?.declared ?? {},
            region,
            accountId: gathered.desired.accountId,
          },
          item.ops
        );
        r = { ok: true };
      } catch (e) {
        r = { ok: false, error: (e as Error).message };
      }
    } else {
      r = await applyRevertItem(cc, item);
    }
    console.log(
      r.ok
        ? style.ok(`  reverted: ${item.displayId}`)
        : style.fail(`  FAILED: ${item.displayId} — ${r.error}`)
    );
    if (!r.ok) worst = Math.max(worst, 2);
  }

  // Re-check convergence — scoped to the resources the revert just touched (R44).
  // A full gatherFindings here re-read the ENTIRE stack (a long silent wait that
  // scaled with stack size, not with the revert); regatherTouched re-reads only
  // plan.items and carries every other finding forward from the original gather.
  const touched = new Set(plan.items.map((i) => i.logicalId));
  console.log(
    '\n' + style.infoTier(`verifying convergence (re-reading ${touched.size} resource(s))...`)
  );
  const reconcile = (findings: Finding[]): Finding[] =>
    applyIgnores(applyBaseline(findings, baseline, { declaredByLogical }), stackName, config);
  let post = reconcile(await regatherTouched(gathered, touched, region));
  if (driftCount(post.filter((f) => touched.has(f.logicalId))) > 0) {
    // A touched resource still reads as drifted. SDK-writer paths (IAM etc.) are
    // eventually consistent — the old slow full re-gather granted propagation time
    // for free; the scoped read must wait deliberately. One retry only.
    await sleep(p.convergeRetryDelayMs ?? CONVERGE_RETRY_DELAY_MS);
    post = reconcile(await regatherTouched(gathered, touched, region));
  }
  const remainingDrift = post.filter(isDrift);
  const remaining = remainingDrift.length;
  console.log(
    remaining === 0
      ? style.clean(`${stackName}: CLEAN after revert.`)
      : style.drift(`${stackName}: ${remaining} drift(s) remain.`)
  );
  // Say WHICH drift survived — without this the user must re-run `check` just to
  // learn what didn't converge (R46). A terse id-per-line pointer, not a report.
  for (const f of remainingDrift) {
    const id = f.constructPath ?? f.logicalId;
    console.log(`  - ${id}${f.path ? `.${f.path}` : ''} (${f.tier})`);
  }
  if (remaining > 0) worst = Math.max(worst, 1);
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
  accept: boolean; // an undeclared drift exists to accept
  revert: boolean; // at least one finding is revertable
}

/**
 * Which interactive actions make sense for a stack's (baseline-reconciled) findings:
 *  - Accept only when there is undeclared drift (accept can't fix declared drift —
 *    template-vs-reality is unrelated to the baseline);
 *  - Revert only when buildRevertPlan yields >=1 revertable item (a stack with only
 *    not-revertable findings, e.g. deleted-only, offers no Revert).
 * Pure: no AWS, no prompts. `schemas` feeds the create-only revert gate.
 */
export function availableActions(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  schemas: Map<string, SchemaInfo>,
  removeUnaccepted: boolean
): Actions {
  const accept = findings.some((f) => f.tier === 'undeclared');
  const plan = buildRevertPlan(findings, baseline, { removeUnaccepted, schemas });
  return { accept, revert: plan.items.length > 0 };
}

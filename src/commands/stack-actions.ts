// Per-stack accept / revert actions, shared by the standalone `accept` / `revert`
// commands AND `check`'s interactive after-drift prompt (R28). Extracting them keeps
// the interactive flow and the single-verb commands behaviourally identical: both go
// through exactly the same bless / plan / apply / converge code.
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { confirm, isCancel, multiselect } from '@clack/prompts';
import {
  acceptedKey,
  applyBaseline,
  type BaselineFile,
  blessStack,
  buildAccepted,
  declaredKeysByLogical,
  loadBaseline,
  selectAccepted,
} from '../baseline/baseline-file.js';
import { applyRevertItem } from '../revert/apply.js';
import { buildRevertPlan, type RevertPlan } from '../revert/plan.js';
import { SDK_WRITERS } from '../revert/writers.js';
import type { Finding, SchemaInfo } from '../types.js';
import { type Desired } from '../desired/template-adapter.js';
import { type GatherResult, gatherFindings } from './gather.js';

const driftCount = (findings: Finding[]): number =>
  findings.filter((f) => f.tier === 'deleted' || f.tier === 'declared' || f.tier === 'undeclared')
    .length;

// ---- accept ----

export interface AcceptStackParams {
  stackName: string;
  region: string;
  desired: Desired;
  findings: Finding[]; // the gather's findings (undeclared still present, pre-baseline)
  yes: boolean;
}

/**
 * Bless the current undeclared state into the baseline file. In a TTY (no --yes) the
 * user picks WHICH undeclared values to bless (selective accept, R14); an empty
 * selection is confirmed first (R19). Returns true if a baseline was written, false
 * if the user cancelled. (Same flow whether reached via `cdkrd accept` or check's
 * interactive prompt — neither re-gathers.)
 */
export async function acceptStack(p: AcceptStackParams): Promise<boolean> {
  const { stackName, region, desired, findings, yes } = p;
  if (!yes && (await loadBaseline(stackName, desired.accountId, region)))
    console.error(
      `note: ${stackName}: overwriting existing baseline (it is git-tracked; review the diff). Pass --yes to silence.`
    );
  let accepted = buildAccepted(findings);
  if (!yes && process.stdin.isTTY && accepted.length > 0) {
    const picked = await multiselect({
      message: `${stackName}: select undeclared value(s) to bless (unselected stay reported)`,
      options: accepted.map((e) => ({ value: acceptedKey(e), label: `${e.logicalId}.${e.path}` })),
      initialValues: accepted.map((e) => acceptedKey(e)), // default = all selected
      required: false,
    });
    if (isCancel(picked)) {
      console.error(`note: ${stackName}: accept cancelled — baseline unchanged`);
      return false;
    }
    // Empty selection writes an EMPTY baseline, which CREATES the file and lifts R2's
    // no-baseline revert guard — `revert` would then plan REMOVAL of all undeclared
    // drift. Confirm that consequence explicitly before writing (R19).
    if (picked.length === 0) {
      const proceed = await confirm({
        message: `${stackName}: bless nothing? This writes an EMPTY baseline — \`cdkrd revert\` will then plan REMOVAL of ALL undeclared drift on this stack.`,
        initialValue: false,
      });
      if (isCancel(proceed) || !proceed) {
        console.error(`note: ${stackName}: accept cancelled — baseline unchanged`);
        return false;
      }
    }
    accepted = selectAccepted(findings, new Set(picked));
  }
  const { path, count } = await blessStack(
    stackName,
    region,
    desired.accountId,
    findings,
    desired.rawTemplate,
    accepted
  );
  console.log(`baseline written: ${path} (${count} undeclared value(s) blessed)`);
  return true;
}

// ---- revert ----

function printPlan(stackName: string, region: string, plan: RevertPlan): void {
  console.log(`\n=== cdkrd revert: ${stackName} (${region}) ===`);
  for (const item of plan.items) {
    console.log(`\n  ${item.displayId} (${item.resourceType})`);
    for (const op of item.ops) console.log(`    - ${op.human}`);
  }
  if (plan.notRevertable.length > 0) {
    console.log(`\n  NOT revertable (${plan.notRevertable.length}):`);
    for (const n of plan.notRevertable)
      console.log(`    - ${n.displayId}.${n.path} (${n.resourceType}) — ${n.reason}`);
  }
}

export interface RevertStackParams {
  stackName: string;
  region: string;
  gathered: GatherResult; // the check/revert gather (findings + desired + schemas)
  baseline: BaselineFile | undefined;
  dryRun: boolean;
  yes: boolean;
  removeUnblessed: boolean;
}

/**
 * Build the revert plan from the gather's findings + baseline, show it, confirm
 * (unless --yes / --dry-run), apply via Cloud Control / SDK writers, then re-gather
 * to verify convergence. Returns the exit contribution: 0 clean / 1 drift remains /
 * 2 apply failure (or a non-interactive write refusal). Does NOT re-gather to build
 * the plan (uses the passed gather) — only the convergence re-check re-gathers.
 */
export async function revertStack(p: RevertStackParams): Promise<number> {
  const { stackName, region, gathered, baseline, dryRun, yes, removeUnblessed } = p;
  let worst = 0;
  const declaredByLogical = declaredKeysByLogical(gathered.desired.resources);
  const drifted = applyBaseline(gathered.findings, baseline, {
    declaredByLogical,
    warn: console.error,
  });
  const plan = buildRevertPlan(drifted, baseline, { removeUnblessed, schemas: gathered.schemas });

  if (plan.items.length === 0 && plan.notRevertable.length === 0) {
    console.log(`${stackName} (${region}): no drift to revert.`);
    return 0;
  }
  printPlan(stackName, region, plan);
  if (plan.items.length === 0) return 0; // nothing revertable

  const opCount = plan.items.reduce((n, i) => n + i.ops.length, 0);
  if (dryRun) {
    console.log(
      `\n(dry-run) would apply ${opCount} op(s) to ${plan.items.length} resource(s). No changes made.`
    );
    return 0;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(
        `\nrefusing to write to AWS non-interactively — pass --yes to apply (or --dry-run to preview).`
      );
      return 2;
    }
    const ok = await confirm({
      message: `Apply ${opCount} revert op(s) to ${stackName}? This WRITES to AWS.`,
    });
    if (isCancel(ok) || !ok) {
      console.log('aborted.');
      return 0;
    }
  }

  const cc = new CloudControlClient({ region });
  const byLogical = new Map(gathered.desired.resources.map((res) => [res.logicalId, res]));
  for (const item of plan.items) {
    let r: { ok: boolean; error?: string };
    if (item.kind === 'sdk') {
      const res = byLogical.get(item.logicalId);
      try {
        await SDK_WRITERS[item.resourceType]!(
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
      r.ok ? `  reverted: ${item.displayId}` : `  FAILED: ${item.displayId} — ${r.error}`
    );
    if (!r.ok) worst = Math.max(worst, 2);
  }

  // re-check convergence (re-gather is allowed here — the world changed)
  const remaining = driftCount(
    applyBaseline((await gatherFindings(stackName, region)).findings, baseline, {
      declaredByLogical,
    })
  );
  console.log(
    remaining === 0
      ? `${stackName}: CLEAN after revert.`
      : `${stackName}: ${remaining} drift(s) remain.`
  );
  if (remaining > 0) worst = Math.max(worst, 1);
  return worst;
}

// ---- interactive choice (pure, unit-tested) ----

export interface Actions {
  accept: boolean; // an undeclared drift exists to bless
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
  removeUnblessed: boolean
): Actions {
  const accept = findings.some((f) => f.tier === 'undeclared');
  const plan = buildRevertPlan(findings, baseline, { removeUnblessed, schemas });
  return { accept, revert: plan.items.length > 0 };
}

// `cdkrd revert [<stack>...] [--all] [--app ...] [--region r] [--profile p]
//              [--dry-run] [--yes]`
// The ONLY AWS-mutating command. Reverts drift to its desired value:
//   declared   -> deployed-template value
//   undeclared -> baseline value (restore) or removal (if never blessed)
// Shows a plan, confirms (unless --yes / --dry-run), applies via Cloud Control
// UpdateResource, then re-checks for convergence.
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { confirm, isCancel } from '@clack/prompts';
import { isStackNotDeployed } from '../aws-errors.js';
import { applyBaseline, type BaselineFile, loadBaseline } from '../baseline/baseline-file.js';
import { parseCommonArgs } from '../cli-args.js';
import { applyRevertItem } from '../revert/apply.js';
import { buildRevertPlan, type RevertPlan } from '../revert/plan.js';
import { SDK_WRITERS } from '../revert/writers.js';
import type { Finding } from '../types.js';
import { gatherFindings } from './gather.js';
import { resolveStacks } from './resolve-stacks.js';

const driftCount = (findings: Finding[]): number =>
  findings.filter((f) => f.tier === 'declared' || f.tier === 'undeclared').length;

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

export async function runRevert(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile;
  const dryRun = args.includes('--dry-run');

  const stacks = await resolveStacks(a);
  if (stacks.length === 0) {
    console.error(
      'usage: cdkrd revert <stack>... | --all | (CDK app dir / --app) [--region r] [--profile p] [--dry-run] [--yes]'
    );
    if (a.all && !a.region)
      console.error('  (--all needs a region: pass --region or set AWS_REGION)');
    return 2;
  }

  let worst = 0;
  for (const { stackName, region } of stacks) {
    if (!region) {
      console.error(`error: ${stackName}: no region — set env on the stack or pass --region`);
      worst = Math.max(worst, 2);
      continue;
    }
    try {
      const baseline: BaselineFile | undefined = await loadBaseline(stackName, region);
      const gathered = await gatherFindings(stackName, region);
      const drifted = applyBaseline(gathered.findings, baseline);
      const plan = buildRevertPlan(drifted, baseline);

      if (plan.items.length === 0 && plan.notRevertable.length === 0) {
        console.log(`${stackName} (${region}): no drift to revert.`);
        continue;
      }
      printPlan(stackName, region, plan);
      if (plan.items.length === 0) continue; // nothing revertable

      const opCount = plan.items.reduce((n, i) => n + i.ops.length, 0);
      if (dryRun) {
        console.log(
          `\n(dry-run) would apply ${opCount} op(s) to ${plan.items.length} resource(s). No changes made.`
        );
        continue;
      }
      if (!a.yes) {
        if (!process.stdin.isTTY) {
          console.error(
            `\nrefusing to write to AWS non-interactively — pass --yes to apply (or --dry-run to preview).`
          );
          worst = Math.max(worst, 2);
          continue;
        }
        const ok = await confirm({
          message: `Apply ${opCount} revert op(s) to ${stackName}? This WRITES to AWS.`,
        });
        if (isCancel(ok) || !ok) {
          console.log('aborted.');
          continue;
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

      // re-check convergence
      const remaining = driftCount(
        applyBaseline((await gatherFindings(stackName, region)).findings, baseline)
      );
      console.log(
        remaining === 0
          ? `${stackName}: CLEAN after revert.`
          : `${stackName}: ${remaining} drift(s) remain.`
      );
      if (remaining > 0) worst = Math.max(worst, 1);
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed — skipped`);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  return worst;
}

// `cdkrd revert [<stack>...] [--all] [--app ...] [--region r] [--profile p]
//              [--dry-run] [--yes]`
// The ONLY AWS-mutating command. Reverts drift to its desired value:
//   declared   -> deployed-template value
//   undeclared -> baseline value (restore) or removal (if never blessed)
// The per-stack plan / apply / converge flow lives in stack-actions.ts (shared with
// check's interactive prompt, R28).
import { isStackNotDeployed } from '../aws-errors.js';
import {
  type BaselineFile,
  checkBaselineAccount,
  loadBaseline,
} from '../baseline/baseline-file.js';
import { parseCommonArgs } from '../cli-args.js';
import { gatherFindings } from './gather.js';
import { resolveStacks } from './resolve-stacks.js';
import { revertStack } from './stack-actions.js';

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
      // gather FIRST: the baseline filename embeds the accountId, which only the
      // gather (DescribeStackResources) resolves. (R21 — was load-then-gather.)
      const gathered = await gatherFindings(stackName, region);
      const baseline: BaselineFile | undefined = await loadBaseline(
        stackName,
        gathered.desired.accountId,
        region
      );
      if (baseline) checkBaselineAccount(baseline, gathered.desired.accountId, stackName);
      worst = Math.max(
        worst,
        await revertStack({
          stackName,
          region,
          gathered,
          baseline,
          dryRun,
          yes: a.yes,
          removeUnblessed: a.removeUnblessed,
        })
      );
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

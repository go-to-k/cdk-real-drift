// `cdkrd accept [<stack>...] [--all] [--app ...] [--region r] [--profile p] [--yes]`
// Write the current undeclared state into the baseline FILE(s). Writes ONLY
// git-committed baselines; no AWS writes.
import { isStackNotDeployed } from '../aws-errors.js';
import { blessStack, loadBaseline } from '../baseline/baseline-file.js';
import { parseCommonArgs } from '../cli-args.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';

export async function runAccept(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile;

  const stacks = await resolveStacks(a);
  if (stacks.length === 0) {
    console.error(
      'usage: cdkrd accept <stack>... | --all | (run in a CDK app dir / --app) [--region r] [--profile p] [--yes]'
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
      if (!a.yes && (await loadBaseline(stackName, region))) {
        console.error(
          `note: ${stackName}: overwriting existing baseline (it is git-tracked; review the diff). Pass --yes to silence.`
        );
      }
      const { desired, findings } = await gatherFindings(stackName, region);
      const { path, count } = await blessStack(stackName, region, findings, desired.rawTemplate);
      console.log(`baseline written: ${path} (${count} undeclared value(s) blessed)`);
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed yet — nothing to bless`);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  if (worst === 0)
    console.log('commit the baseline file(s) so drift is detected against them going forward.');
  return worst;
}

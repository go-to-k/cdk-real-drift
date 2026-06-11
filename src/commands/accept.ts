// `cdkrd accept [<stack>...] [--all] [--app ...] [--region r] [--profile p] [--yes]`
// Write the current undeclared state into the baseline FILE(s). Writes ONLY
// git-committed baselines; no AWS writes. The per-stack bless flow lives in
// stack-actions.ts (shared with check's interactive prompt, R28).
import { isStackNotDeployed } from '../aws-errors.js';
import { parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import { acceptStack } from './stack-actions.js';

export async function runAccept(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile;

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }

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
      // gather FIRST: the baseline filename embeds the accountId, which only the
      // gather (DescribeStackResources) resolves. (R21 — was load-then-gather.)
      const { desired, findings } = await gatherFindings(stackName, region);
      // ignore rules re-tag matching undeclared findings out of the bless set, so an
      // externally-managed property is never blessed (and never re-detected).
      await acceptStack({
        stackName,
        region,
        desired,
        findings: applyIgnores(findings, stackName, config),
        yes: a.yes,
      });
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

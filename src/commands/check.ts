// `cdkrd check [<stack>...] [--all] [--region r] [--json] [--fail-on declared|undeclared] [--show-all]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a blessed stack reports CLEAN. Exit code is the
// worst across all checked stacks (0 clean / 1 drift / 2 error).
import { isStackNotDeployed } from '../aws-errors.js';
import { applyBaseline, loadBaseline } from '../baseline/baseline-file.js';
import { parseCommonArgs } from '../cli-args.js';
import { report } from '../report/report.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';

export async function runCheck(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (!a.region) {
    console.error('error: no AWS region. Pass --region or set AWS_REGION / AWS_DEFAULT_REGION.');
    return 2;
  }
  const region = a.region;
  const stacks = await resolveStacks(a, region);
  if (stacks.length === 0) {
    console.error(
      'usage: cdkrd check <stack>... | --all | (run in a CDK app dir / --app) [--region r] [--json] [--fail-on declared|undeclared] [--show-all]'
    );
    return 2;
  }

  let worst = 0;
  for (const stackName of stacks) {
    try {
      const { findings } = await gatherFindings(stackName, region);
      const baseline = a.showAll ? undefined : await loadBaseline(stackName, region);
      if (!a.json && !baseline && !a.showAll) {
        console.error(
          `note: ${stackName}: no baseline — showing all undeclared state. Run \`cdkrd accept ${stackName}\` to bless it.`
        );
      }
      const code = report(applyBaseline(findings, baseline), `${stackName} (${region})`, {
        json: a.json,
        failOn: a.failOn,
      });
      worst = Math.max(worst, code);
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed yet — skipped`);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  return worst;
}

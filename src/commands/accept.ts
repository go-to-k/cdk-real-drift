// `cdkrd accept [<stack>...] [--all]` (alias: init) — write the current undeclared
// state into the baseline FILE(s). Writes ONLY git-committed baselines; no AWS writes.
import {
  buildAccepted,
  hashTemplate,
  loadBaseline,
  writeBaseline,
} from '../baseline/baseline-file.js';
import { isStackNotDeployed } from '../aws-errors.js';
import { parseCommonArgs } from '../cli-args.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';

export async function runAccept(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (!a.region) {
    console.error('error: no AWS region. Pass --region or set AWS_REGION / AWS_DEFAULT_REGION.');
    return 2;
  }
  const region = a.region;
  const stacks = await resolveStacks(a, region);
  if (stacks.length === 0) {
    console.error(
      'usage: cdkrd accept <stack>... | --all | (run in a CDK app dir / --app) [--region r] [--yes]'
    );
    return 2;
  }

  let worst = 0;
  for (const stackName of stacks) {
    try {
      if (!a.yes && (await loadBaseline(stackName, region))) {
        console.error(
          `note: ${stackName}: overwriting existing baseline (it is git-tracked; review the diff). Pass --yes to silence.`
        );
      }
      const { desired, findings } = await gatherFindings(stackName, region);
      const accepted = buildAccepted(findings);
      const path = await writeBaseline({
        schemaVersion: 1,
        stackName,
        region,
        capturedAt: new Date().toISOString(),
        templateHash: hashTemplate(desired.rawTemplate),
        accepted,
      });
      console.log(`baseline written: ${path} (${accepted.length} undeclared value(s) blessed)`);
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

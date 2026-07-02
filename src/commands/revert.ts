// `cdkrd revert [<stack>...] [--app ...] [--region r] [--profile p]
//              [--dry-run] [--yes]`
// The ONLY AWS-mutating command. Reverts drift to its desired value:
//   declared   -> deployed-template value
//   undeclared -> baseline value (restore) or removal (if never recorded)
// The per-stack plan / apply / converge flow lives in stack-actions.ts (shared with
// check's interactive prompt, R28).
import { isStackNotDeployed, StackNotCheckableError } from '../aws-errors.js';
import {
  type BaselineFile,
  checkBaselineAccount,
  loadBaseline,
} from '../baseline/baseline-file.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { loadConfig } from '../config/config-file.js';
import { gatherFindings } from './gather.js';
import { gatherWithProgress, progressLabel } from './progress.js';
import { resolveStacks } from './resolve-stacks.js';
import { revertStack } from './stack-actions.js';

export async function runRevert(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile;
  const dryRun = args.includes('--dry-run');

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }

  let stacks;
  try {
    stacks = await resolveStacks(a);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  if (stacks.length === 0) {
    console.error('note: the CDK app defines no stacks — nothing to revert');
    return 0;
  }

  let worst = 0;
  // gather-phase spinner (see gatherWithProgress) — text mode + TTY only. The revert
  // confirm prompt fires AFTER the gather, so the spinner never overlaps it.
  const showProgress = !a.json && isInteractive();
  for (const [idx, { stackName, region, template }] of stacks.entries()) {
    if (!region) {
      console.error(
        `error: ${stackName}: no region — set env on the stack, pass --region, or set a region for the AWS profile`
      );
      worst = Math.max(worst, 2);
      continue;
    }
    try {
      // gather FIRST: the baseline filename embeds the accountId, which only the
      // gather (DescribeStackResources) resolves. (R21 — was load-then-gather.)
      // `template` (synth) recovers GetTemplate's `?`-masked non-ASCII literals so a
      // revert writes the REAL declared value, never a `?????` mask.
      const gathered = await gatherWithProgress(
        showProgress,
        progressLabel(idx, stacks.length, stackName, region),
        () => gatherFindings(stackName, region, undefined, template)
      );
      const baseline: BaselineFile | undefined = await loadBaseline(
        stackName,
        gathered.desired.accountId,
        region
      );
      if (baseline) checkBaselineAccount(baseline, gathered.desired.accountId, stackName);
      // standalone revert: an aborted confirm means nothing changed → exit 0 (the
      // outcome's `exit` already encodes that; `aborted` is only consulted by check).
      const { exit } = await revertStack({
        stackName,
        region,
        gathered,
        baseline,
        config,
        dryRun,
        yes: a.yes,
        removeUnrecorded: a.removeUnrecorded,
        verbose: a.verbose,
        interactive: isInteractive(),
        ...(a.waitMs !== undefined && { waitMs: a.waitMs }),
      });
      worst = Math.max(worst, exit);
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed — skipped`);
        continue;
      }
      if (e instanceof StackNotCheckableError) {
        console.error(`note: ${stackName}: ${e.message} — skipped`);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  return worst;
}

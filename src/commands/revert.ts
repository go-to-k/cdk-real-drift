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
import { emitJsonArray, type RevertJson, stackLabel } from './verb-json.js';

export async function runRevert(args: string[]): Promise<number> {
  const a = parseCommonArgs(args, 'revert');
  if (a.profile) process.env.AWS_PROFILE = a.profile;
  const dryRun = args.includes('--dry-run');

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    if (a.json) emitJsonArray([]); // keep stdout a valid (empty) JSON array on a top-level error (#988)
    return 2;
  }

  let stacks;
  try {
    stacks = await resolveStacks(a);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    if (a.json) emitJsonArray([]); // keep stdout a valid (empty) JSON array on a top-level error (#868)
    return 2;
  }
  if (stacks.length === 0) {
    console.error('note: the CDK app defines no stacks — nothing to revert');
    if (a.json) emitJsonArray([]);
    return 0;
  }

  const jsonReports: RevertJson[] = []; // #868: collected per stack, printed once after the loop
  let worst = 0;
  // gather-phase spinner (see gatherWithProgress) — text mode + TTY only. The revert
  // confirm prompt fires AFTER the gather, so the spinner never overlaps it.
  const showProgress = !a.json && isInteractive();
  for (const [idx, { stackName, region, template }] of stacks.entries()) {
    if (!region) {
      const msg =
        'no region — set env on the stack, pass --region, or set a region for the AWS profile';
      console.error(`error: ${stackName}: ${msg}`);
      if (a.json)
        jsonReports.push({
          stack: stackName,
          reverted: 0,
          failed: 0,
          aborted: false,
          exit: 2,
          error: msg,
        });
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
      const outcome = await revertStack({
        stackName,
        region,
        gathered,
        baseline,
        config,
        dryRun,
        yes: a.yes,
        removeUnrecorded: a.removeUnrecorded,
        verbose: a.verbose,
        // --json is a scripting/non-TTY contract: never show the op multiselect / confirm.
        // Without --yes this makes revert refuse the AWS write (exit 2 in the JSON). (#868)
        interactive: a.json ? false : isInteractive(),
        ...(a.waitMs !== undefined && { waitMs: a.waitMs }),
        json: a.json,
      });
      worst = Math.max(worst, outcome.exit);
      if (a.json)
        jsonReports.push({
          stack: stackLabel(stackName, region),
          reverted: outcome.reverted ?? 0,
          failed: outcome.failed ?? 0,
          aborted: outcome.aborted,
          exit: outcome.exit,
          // #1096: a --dry-run element carries the would-apply counts, and a refusal element
          // its reason — otherwise a would-apply-N-ops preview is indistinguishable from a
          // clean no-op. Omitted (not `0`/empty) when not applicable.
          ...(outcome.plannedOps !== undefined && { plannedOps: outcome.plannedOps }),
          ...(outcome.plannedResources !== undefined && {
            plannedResources: outcome.plannedResources,
          }),
          ...(outcome.refusedReason !== undefined && { refusedReason: outcome.refusedReason }),
        });
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed — skipped`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            reverted: 0,
            failed: 0,
            aborted: false,
            exit: 0,
            error: 'not deployed — skipped',
          });
        continue;
      }
      if (e instanceof StackNotCheckableError) {
        console.error(`note: ${stackName}: ${e.message} — skipped`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            reverted: 0,
            failed: 0,
            aborted: false,
            exit: 0,
            error: `${e.message} — skipped`,
          });
        continue;
      }
      const msg = (e as Error).message;
      console.error(`error: ${stackName}: ${msg}`);
      if (a.json)
        jsonReports.push({
          stack: stackLabel(stackName, region),
          reverted: 0,
          failed: 0,
          aborted: false,
          exit: 2,
          error: msg,
        });
      worst = Math.max(worst, 2);
    }
  }
  if (a.json) emitJsonArray(jsonReports);
  return worst;
}

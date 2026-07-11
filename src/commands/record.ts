// `cdkrd record [<stack>...] [--app ...] [--region r] [--profile p] [--yes]`
// Write the current undeclared state into the baseline FILE(s). Writes ONLY
// git-committed baselines; no AWS writes. The per-stack record flow lives in
// stack-actions.ts (shared with check's interactive prompt, R28).
import { isStackNotDeployed, StackNotCheckableError } from '../aws-errors.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import { gatherWithProgress, progressLabel } from './progress.js';
import { recordStack, warnStackStatus } from './stack-actions.js';
import { emitJsonArray, type RecordJson, stackLabel } from './verb-json.js';

export async function runRecord(args: string[]): Promise<number> {
  const a = parseCommonArgs(args, 'record');
  if (a.profile) process.env.AWS_PROFILE = a.profile;

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
    console.error('note: the CDK app defines no stacks — nothing to record');
    if (a.json) emitJsonArray([]);
    return 0;
  }

  // #868: in --json mode each stack's outcome is collected and printed once, after the
  // loop, as ONE top-level JSON array (symmetric with check). Text mode leaves it empty.
  const jsonReports: RecordJson[] = [];
  let worst = 0;
  // Did ANY stack actually write a baseline? Cancelling the record multiselect (or the
  // empty-baseline confirm) returns `{ wrote:false, refused:false }` — a clean no-op, not
  // an error — so `worst` stays 0. Without tracking `wrote`, the "commit the baseline
  // file(s)" footer would fire even when nothing was written, telling the user to commit
  // files that never changed (#799).
  let wroteAny = false;
  // gather-phase spinner (see gatherWithProgress) — text mode + TTY only.
  const showProgress = !a.json && isInteractive();
  for (const [idx, { stackName, region, template }] of stacks.entries()) {
    if (!region) {
      const msg =
        'no region — set env on the stack, pass --region, or set a region for the AWS profile';
      console.error(`error: ${stackName}: ${msg}`);
      if (a.json) jsonReports.push({ stack: stackName, recorded: 0, wrote: false, error: msg });
      worst = Math.max(worst, 2);
      continue;
    }
    try {
      // gather FIRST: the baseline filename embeds the accountId, which only the
      // gather (DescribeStackResources) resolves. (R21 — was load-then-gather.)
      // `template` (synth) recovers GetTemplate's `?`-masked non-ASCII literals.
      const { desired, findings } = await gatherWithProgress(
        showProgress,
        progressLabel(idx, stacks.length, stackName, region),
        () => gatherFindings(stackName, region, undefined, template)
      );
      // #786: warn loudly when the stack is mid-operation / failed — recording now would
      // snapshot TRANSIENT live values into the git-committed baseline. Same wording/stderr
      // routing check uses; a --yes run still records (just warned), matching check's behavior.
      warnStackStatus(stackName, desired.stackStatusWarning);
      // ignore rules re-tag matching undeclared findings out of the record set, so an
      // externally-managed property is never recorded (and never re-detected).
      const result = await recordStack({
        stackName,
        region,
        desired,
        findings: applyIgnores(
          findings,
          { stackName, accountId: desired.accountId, region },
          config
        ),
        yes: a.yes,
        // --json is a scripting/non-TTY contract: never show the interactive multiselect
        // (it would block a pipe and pollute stdout). Without --yes this makes a
        // decision-requiring record refuse (recorded in the JSON element). (#868)
        interactive: a.json ? false : isInteractive(),
        expandNested: a.verbose, // --verbose itemizes the nested sub-keys (--show-all is the separate inventory mode, not a picker-detail flag)
        json: a.json,
      });
      // a non-interactive record that needed a decision but had no --yes refuses (R38)
      if (result.refused) worst = Math.max(worst, 2);
      if (result.wrote) wroteAny = true;
      if (a.json)
        jsonReports.push({
          stack: stackLabel(stackName, region),
          recorded: result.count ?? 0,
          wrote: result.wrote,
          ...(result.refused && { refused: true }),
          ...(result.path !== undefined && { baselinePath: result.path }),
        });
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed yet — nothing to record`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            recorded: 0,
            wrote: false,
            error: 'not deployed yet — nothing to record',
          });
        continue;
      }
      if (e instanceof StackNotCheckableError) {
        console.error(`note: ${stackName}: ${e.message} — nothing to record`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            recorded: 0,
            wrote: false,
            error: `${e.message} — nothing to record`,
          });
        continue;
      }
      const msg = (e as Error).message;
      console.error(`error: ${stackName}: ${msg}`);
      if (a.json)
        jsonReports.push({
          stack: stackLabel(stackName, region),
          recorded: 0,
          wrote: false,
          error: msg,
        });
      worst = Math.max(worst, 2);
    }
  }
  if (a.json) {
    emitJsonArray(jsonReports);
    return worst;
  }
  // Only nudge the user to commit when a baseline was actually written — cancelling every
  // stack's record prompt leaves the files untouched, so the "commit …" footer would be a
  // lie (#799). Gate on `wroteAny` alone, NOT `worst === 0`: in a multi-stack run a written
  // baseline still needs committing even when a SIBLING stack errored (worst === 2). The
  // exit code is unaffected — a written file the user might otherwise forget to commit is
  // exactly what the footer must catch under a partial failure (#949).
  if (wroteAny)
    console.log('commit the baseline file(s) so drift is detected against them going forward.');
  return worst;
}

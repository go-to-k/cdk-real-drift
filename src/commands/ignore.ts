// `cdkrd ignore [<stack>...] [--app ...] [--region r] [--profile p] [--yes]`
// Append ignore rules to .cdkrd/ignore.yaml for the chosen declared/undeclared drift —
// it stops being reported entirely (the "stop watching" counterpart to `record`, which
// keeps watching). Writes ONLY the git-committed config file; no AWS writes. The
// per-stack ignore flow lives in stack-actions.ts (shared with check's interactive
// prompt in PR-B2).
import { isStackNotDeployed, StackNotCheckableError } from '../aws-errors.js';
import {
  applyBaseline,
  type ApplyBaselineOptions,
  checkBaselineAccount,
  constructPathsByLogical,
  declaredKeysByLogical,
  loadBaseline,
  physicalIdsByLogical,
} from '../baseline/baseline-file.js';
import type { Desired } from '../desired/template-adapter.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { createAccountGate } from './account-gate.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import { gatherWithProgress, progressLabel } from './progress.js';
import { ignoreStack, warnStackStatus } from './stack-actions.js';
import { emitJsonArray, type IgnoreJson, stackLabel } from './verb-json.js';

// Build the applyBaseline options the `ignore` verb reconciles with. Extracted +
// exported so a unit test can assert the opts include `constructPathByLogical`
// (#1285): the ignore verb was the ONLY applyBaseline caller that omitted it, so a
// synthetic "baseline value removed since record" finding carried no constructPath
// and the constructPath-form ignore rule check.ts writes by preference never matched
// it — `ignore --yes` then appended a duplicate, logicalId-form rule. Mirrors the
// opts check.ts / stack-actions.ts / interactive-resolve.ts already build.
export function ignoreApplyBaselineOpts(desired: Pick<Desired, 'resources'>): ApplyBaselineOptions {
  return {
    declaredByLogical: declaredKeysByLogical(desired.resources),
    constructPathByLogical: constructPathsByLogical(desired.resources),
    physicalIdByLogical: physicalIdsByLogical(desired.resources),
    allLogicalIds: desired.resources.map((r) => r.logicalId),
    warn: console.error,
  };
}

export async function runIgnore(args: string[]): Promise<number> {
  const a = parseCommonArgs(args, 'ignore');
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
    console.error('note: the CDK app defines no stacks — nothing to ignore');
    if (a.json) emitJsonArray([]);
    return 0;
  }

  const jsonReports: IgnoreJson[] = []; // #868: collected per stack, printed once after the loop
  let worst = 0;
  let wroteAny = false;
  // gather-phase spinner (see gatherWithProgress) — text mode + TTY only.
  const showProgress = !a.json && isInteractive();
  // #1309: the #740 cross-account mismatch gate (previously check-only). Without it, a
  // stack env-pinned to another account either misreported "not deployed yet" or — with
  // a same-named stack in the reachable account — appended ignore rules scoped to the
  // WRONG accountId (and offered the wrong account's drift to pick from). Skip (not
  // error), mirroring check: a multi-account app is operated one account at a time.
  const accountGate = createAccountGate('ignore');
  for (const [idx, { stackName, region, account, template }] of stacks.entries()) {
    if (!region) {
      const msg =
        'no region — set env on the stack, pass --region, or set a region for the AWS profile';
      console.error(`error: ${stackName}: ${msg}`);
      if (a.json) jsonReports.push({ stack: stackName, added: 0, wrote: false, error: msg });
      worst = Math.max(worst, 2);
      continue;
    }
    try {
      // #1309 pre-read gate: a proven mismatch skips BEFORE any live read, so the wrong
      // account is never even queried (same placement as check's gate).
      const mismatch = await accountGate.preRead(account, region);
      if (mismatch.skip) {
        console.error(`note: ${stackName}: ${mismatch.message}`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            added: 0,
            wrote: false,
            error: mismatch.message,
          });
        continue;
      }
      const { desired, findings } = await gatherWithProgress(
        showProgress,
        progressLabel(idx, stacks.length, stackName, region),
        () => gatherFindings(stackName, region, undefined, template)
      );
      // #1309 post-read guard (belt-and-suspenders, mirrors check's #740 case 2): if STS
      // could not resolve the caller, the pre-read gate let the read proceed — a
      // SAME-NAMED stack in the reachable account means the state just read is the wrong
      // account's. Never derive ignore rules from it.
      const readMismatch = accountGate.postRead(account, desired.accountId);
      if (readMismatch.skip) {
        console.error(`note: ${stackName}: ${readMismatch.message}`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            added: 0,
            wrote: false,
            error: readMismatch.message,
          });
        continue;
      }
      // #786: surface the mid-operation / failed-state warning the same way check does —
      // an in-flux stack's drift may be transient, so ignoring it could bake in a rule for
      // a value that settles on its own once the deploy completes.
      warnStackStatus(stackName, desired.stackStatusWarning);
      // Reconcile exactly as check does so the offered drift matches what the user saw:
      // suppress already-recorded baseline entries, then re-tag config-ignored findings
      // out (they are already `ignored`, so ignoreStack never re-offers them).
      const baseline = await loadBaseline(stackName, desired.accountId, region);
      if (baseline) checkBaselineAccount(baseline, desired.accountId, stackName);
      const reconciled = applyIgnores(
        applyBaseline(findings, baseline, ignoreApplyBaselineOpts(desired)),
        { stackName, accountId: desired.accountId, region },
        config
      );
      const result = await ignoreStack({
        stackName,
        findings: reconciled,
        yes: a.yes,
        // --json is a scripting/non-TTY contract: never show the multiselect. (#868)
        interactive: a.json ? false : isInteractive(),
        accountId: desired.accountId,
        region,
        json: a.json,
      });
      if (result.wrote) wroteAny = true;
      // a non-interactive ignore that needed a decision but had no --yes refuses (R38)
      if (result.refused) worst = Math.max(worst, 2);
      if (a.json)
        jsonReports.push({
          stack: stackLabel(stackName, region),
          added: result.added,
          wrote: result.wrote,
          ...(result.refused && { refused: true }),
          ...(result.path !== undefined && { config: result.path }),
        });
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed yet — nothing to ignore`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            added: 0,
            wrote: false,
            error: 'not deployed yet — nothing to ignore',
          });
        continue;
      }
      // A stack that exists but has no meaningful deployed state (REVIEW_IN_PROGRESS /
      // deleting): skip, not error — matching check/record/revert. There is nothing to
      // ignore, so one un-checkable stack must not drag the whole run to exit 2.
      if (e instanceof StackNotCheckableError) {
        console.error(`note: ${stackName}: ${e.message} — nothing to ignore`);
        if (a.json)
          jsonReports.push({
            stack: stackLabel(stackName, region),
            added: 0,
            wrote: false,
            error: `${e.message} — nothing to ignore`,
          });
        continue;
      }
      const msg = (e as Error).message;
      console.error(`error: ${stackName}: ${msg}`);
      if (a.json)
        jsonReports.push({
          stack: stackLabel(stackName, region),
          added: 0,
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
  // Nudge to commit whenever a rule was actually written — gate on `wroteAny` alone, NOT
  // `worst === 0`: in a multi-stack run the written ignore.yaml still needs committing even
  // when a SIBLING stack errored (worst === 2). `wroteAny` still guards the all-cancelled
  // case (nothing written → no footer). The exit code is unaffected (#949).
  if (wroteAny)
    console.log('commit .cdkrd/ignore.yaml so the ignore rules apply for everyone going forward.');
  return worst;
}

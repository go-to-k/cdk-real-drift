// `cdkrd ignore [<stack>...] [--app ...] [--region r] [--profile p] [--yes]`
// Append ignore rules to .cdkrd/ignore.yaml for the chosen declared/undeclared drift —
// it stops being reported entirely (the "stop watching" counterpart to `record`, which
// keeps watching). Writes ONLY the git-committed config file; no AWS writes. The
// per-stack ignore flow lives in stack-actions.ts (shared with check's interactive
// prompt in PR-B2).
import { isStackNotDeployed, StackNotCheckableError } from '../aws-errors.js';
import {
  applyBaseline,
  checkBaselineAccount,
  declaredKeysByLogical,
  loadBaseline,
  physicalIdsByLogical,
} from '../baseline/baseline-file.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import { gatherWithProgress, progressLabel } from './progress.js';
import { ignoreStack } from './stack-actions.js';

export async function runIgnore(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile;

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
    console.error('note: the CDK app defines no stacks — nothing to ignore');
    return 0;
  }

  let worst = 0;
  let wroteAny = false;
  // gather-phase spinner (see gatherWithProgress) — text mode + TTY only.
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
      const { desired, findings } = await gatherWithProgress(
        showProgress,
        progressLabel(idx, stacks.length, stackName, region),
        () => gatherFindings(stackName, region, undefined, template)
      );
      // Reconcile exactly as check does so the offered drift matches what the user saw:
      // suppress already-recorded baseline entries, then re-tag config-ignored findings
      // out (they are already `ignored`, so ignoreStack never re-offers them).
      const baseline = await loadBaseline(stackName, desired.accountId, region);
      if (baseline) checkBaselineAccount(baseline, desired.accountId, stackName);
      const reconciled = applyIgnores(
        applyBaseline(findings, baseline, {
          declaredByLogical: declaredKeysByLogical(desired.resources),
          physicalIdByLogical: physicalIdsByLogical(desired.resources),
          allLogicalIds: desired.resources.map((r) => r.logicalId),
          warn: console.error,
        }),
        { stackName, accountId: desired.accountId, region },
        config
      );
      const result = await ignoreStack({
        stackName,
        findings: reconciled,
        yes: a.yes,
        interactive: isInteractive(),
        accountId: desired.accountId,
        region,
      });
      if (result.wrote) wroteAny = true;
      // a non-interactive ignore that needed a decision but had no --yes refuses (R38)
      if (result.refused) worst = Math.max(worst, 2);
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed yet — nothing to ignore`);
        continue;
      }
      // A stack that exists but has no meaningful deployed state (REVIEW_IN_PROGRESS /
      // deleting): skip, not error — matching check/record/revert. There is nothing to
      // ignore, so one un-checkable stack must not drag the whole run to exit 2.
      if (e instanceof StackNotCheckableError) {
        console.error(`note: ${stackName}: ${e.message} — nothing to ignore`);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  if (worst === 0 && wroteAny)
    console.log('commit .cdkrd/ignore.yaml so the ignore rules apply for everyone going forward.');
  return worst;
}

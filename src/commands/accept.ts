// `cdkrd accept [<stack>...] [--all] [--app ...] [--region r] [--profile p] [--yes]`
// Write the current undeclared state into the baseline FILE(s). Writes ONLY
// git-committed baselines; no AWS writes.
import { confirm, isCancel, multiselect } from '@clack/prompts';
import { isStackNotDeployed } from '../aws-errors.js';
import {
  acceptedKey,
  blessStack,
  buildAccepted,
  loadBaseline,
  selectAccepted,
} from '../baseline/baseline-file.js';
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
      // gather FIRST: the baseline filename embeds the accountId, which only the
      // gather (DescribeStackResources) resolves. (R21 — was load-then-gather.)
      const { desired, findings } = await gatherFindings(stackName, region);
      if (!a.yes && (await loadBaseline(stackName, desired.accountId, region))) {
        console.error(
          `note: ${stackName}: overwriting existing baseline (it is git-tracked; review the diff). Pass --yes to silence.`
        );
      }
      // Selective accept: in a TTY without --yes, let the user pick WHICH undeclared
      // values to bless (default = all selected; Enter = same as today). Non-TTY / --yes
      // bless ALL (CI-compatible). Unselected ones stay unblessed → still reported by check.
      let accepted = buildAccepted(findings);
      if (!a.yes && process.stdin.isTTY && accepted.length > 0) {
        const picked = await multiselect({
          message: `${stackName}: select undeclared value(s) to bless (unselected stay reported)`,
          options: accepted.map((e) => ({
            value: acceptedKey(e),
            label: `${e.logicalId}.${e.path}`,
          })),
          initialValues: accepted.map((e) => acceptedKey(e)), // default = all selected
          required: false,
        });
        if (isCancel(picked)) {
          console.error(`note: ${stackName}: accept cancelled — baseline unchanged`);
          continue;
        }
        // Empty selection writes an EMPTY baseline, which CREATES the baseline file
        // and thereby removes R2's no-baseline `revert` guard — `revert` would then
        // plan REMOVAL of every undeclared value. That consequence does not match the
        // "bless nothing" intent, so confirm it explicitly before writing.
        if (picked.length === 0) {
          const proceed = await confirm({
            message: `${stackName}: bless nothing? This writes an EMPTY baseline — \`cdkrd revert\` will then plan REMOVAL of ALL undeclared drift on this stack.`,
            initialValue: false,
          });
          if (isCancel(proceed) || !proceed) {
            console.error(`note: ${stackName}: accept cancelled — baseline unchanged`);
            continue;
          }
        }
        accepted = selectAccepted(findings, new Set(picked));
      }
      const { path, count } = await blessStack(
        stackName,
        region,
        desired.accountId,
        findings,
        desired.rawTemplate,
        accepted
      );
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

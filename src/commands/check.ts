// `cdkrd check [<stack>...] [--all] [--region r] [--profile p] [--app ...] [-c k=v]
//             [--json] [--fail-on declared|undeclared] [--show-all]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a blessed stack reports CLEAN. Exit code is the
// worst across all checked stacks (0 clean / 1 drift / 2 error).
import { confirm, isCancel } from '@clack/prompts';
import { isStackNotDeployed } from '../aws-errors.js';
import {
  applyBaseline,
  blessStack,
  checkBaselineAccount,
  loadBaseline,
} from '../baseline/baseline-file.js';
import { parseCommonArgs } from '../cli-args.js';
import { report } from '../report/report.js';
import { resolveApp } from '../synth/resolve-app.js';
import { synthApp } from '../synth/synth.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';

export async function runCheck(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile; // honored by SDK clients + synth subprocess

  const stacks = await resolveStacks(a);
  if (stacks.length === 0) {
    console.error(
      'usage: cdkrd check <stack>... | --all | (run in a CDK app dir / --app) [--region r] [--profile p] [--json] [--fail-on declared|undeclared] [--show-all]'
    );
    if (a.all && !a.region)
      console.error('  (--all needs a region: pass --region or set AWS_REGION)');
    return 2;
  }

  // --pre-deploy: synth the local app once and use each stack's synth template as
  // the declared source, so check reports the declared drift the next deploy would
  // overwrite (clobber) rather than comparing against the already-deployed template.
  let synthTemplates: Map<string, Record<string, unknown>> | undefined;
  if (a.preDeploy) {
    const app = resolveApp(a.app);
    if (!app) {
      console.error('error: --pre-deploy needs a CDK app (--app or a cdk.json in the cwd)');
      return 2;
    }
    const synthed = await synthApp(app, {
      region: a.region,
      profile: a.profile,
      context: a.context,
    });
    synthTemplates = new Map(synthed.map((s) => [s.stackName, s.template]));
    console.error('(--pre-deploy) comparing live state against the LOCAL synth template');
  }

  let worst = 0;
  for (const { stackName, region } of stacks) {
    if (!region) {
      console.error(`error: ${stackName}: no region — set env on the stack or pass --region`);
      worst = Math.max(worst, 2);
      continue;
    }
    try {
      if (synthTemplates && !synthTemplates.has(stackName)) {
        console.error(`note: ${stackName}: not in the synth output — skipped (--pre-deploy)`);
        continue;
      }
      const { findings, desired } = await gatherFindings(
        stackName,
        region,
        synthTemplates?.get(stackName)
      );
      let baseline = a.showAll ? undefined : await loadBaseline(stackName, region);
      // per-account guard: a baseline captured in a different account is wrong here
      if (baseline) checkBaselineAccount(baseline, desired.accountId, stackName);
      // first run: no baseline yet → offer to bless interactively (TTY only)
      if (!baseline && !a.showAll && !a.json && process.stdin.isTTY) {
        const ok = await confirm({
          message: `${stackName}: no baseline yet. Bless the current state now?`,
        });
        if (!isCancel(ok) && ok) {
          const { count } = await blessStack(
            stackName,
            region,
            desired.accountId,
            findings,
            desired.rawTemplate
          );
          console.error(`baseline written (${count} undeclared value(s) blessed) — commit it.`);
          baseline = await loadBaseline(stackName, region);
        }
      }
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

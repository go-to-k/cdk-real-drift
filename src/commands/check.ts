// `cdkrd check [<stack>...] [--all] [--region r] [--profile p] [--app ...] [-c k=v]
//             [--json] [--fail-on declared|undeclared] [--show-all]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a blessed stack reports CLEAN. Exit code is the
// worst across all checked stacks (0 clean / 1 drift / 2 error).
import { confirm, isCancel, select } from '@clack/prompts';
import { isStackNotDeployed } from '../aws-errors.js';
import {
  applyBaseline,
  blessStack,
  checkBaselineAccount,
  declaredKeysByLogical,
  loadBaseline,
  warnTemplateHashDrift,
} from '../baseline/baseline-file.js';
import { parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { exitCode, report } from '../report/report.js';
import { resolveApp } from '../synth/resolve-app.js';
import { synthApp } from '../synth/synth.js';
import type { Finding } from '../types.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import {
  acceptStack,
  availableActions,
  resolveInteractiveRevertExit,
  revertStack,
} from './stack-actions.js';

// --pre-deploy reports declared-side drift the next deploy would clobber; the
// undeclared tier is meaningless against a synth (not deployed) declared set, so
// it is excluded. Exported (pure) so the contract is unit-tested.
export function preDeployFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.tier !== 'undeclared');
}

export async function runCheck(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (a.profile) process.env.AWS_PROFILE = a.profile; // honored by SDK clients + synth subprocess

  // .cdkrd/config.json ignore rules, loaded once (cwd-relative). A malformed config
  // fails the whole run fast — a silently-ineffective ignore rule is the dangerous case.
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
      const { findings, desired, schemas } = await gatherFindings(
        stackName,
        region,
        synthTemplates?.get(stackName)
      );

      // --pre-deploy: the declared set comes from the LOCAL synth template, so the
      // ONLY meaningful signal is declared drift the next deploy would clobber. The
      // undeclared tier is "live minus declared" — with a synth declared set its
      // meaning silently shifts, so we drop it and do NOT touch the baseline at all
      // (no bless offer, no baseline load — which would also wrongly hash the synth
      // template). See ARCHITECTURE §13-2.
      if (a.preDeploy) {
        const declaredOnly = preDeployFindings(findings);
        if (!a.json)
          console.error(
            `note: ${stackName}: --pre-deploy reports declared drift only (undeclared tiers are evaluated against the deployed template — run check without --pre-deploy)`
          );
        worst = Math.max(
          worst,
          report(applyIgnores(declaredOnly, stackName, config), `${stackName} (${region})`, {
            json: a.json,
            failOn: a.failOn,
            verbose: a.verbose,
          })
        );
        continue;
      }

      let baseline = a.showAll
        ? undefined
        : await loadBaseline(stackName, desired.accountId, region);
      // per-account guard: a baseline captured in a different account is wrong here
      if (baseline) checkBaselineAccount(baseline, desired.accountId, stackName);
      // stale-baseline warning (pre-deploy already returned above, so always safe here)
      if (baseline) warnTemplateHashDrift(baseline, desired.rawTemplate, stackName);
      // first run: no baseline yet → offer to bless interactively (TTY only)
      if (!baseline && !a.showAll && !a.json && process.stdin.isTTY) {
        const ok = await confirm({
          message: `${stackName}: no baseline yet — bless the current UNDECLARED state as the baseline? (declared drift, i.e. reality vs the deployed template, is reported either way)`,
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
          baseline = await loadBaseline(stackName, desired.accountId, region);
        }
      }
      if (!a.json && !baseline && !a.showAll) {
        console.error(
          `note: ${stackName}: no baseline — showing all undeclared state. Run \`cdkrd accept ${stackName}\` to bless it.`
        );
      }
      const reconciled = applyIgnores(
        applyBaseline(findings, baseline, {
          declaredByLogical: declaredKeysByLogical(desired.resources),
          warn: (s: string) => {
            if (!a.json) console.error(s);
          },
        }),
        stackName,
        config
      );
      let code = report(reconciled, `${stackName} (${region})`, {
        json: a.json,
        failOn: a.failOn,
        verbose: a.verbose,
      });

      // R28: drift found in a TTY → offer accept / revert / nothing inline, instead
      // of making the user re-run a separate command. Skipped for --json (machine
      // output), --show-all (baseline not applied — accept would mean something else),
      // and --pre-deploy (declared-only, baseline-untouched contract).
      if (code === 1 && !a.json && !a.showAll && !a.preDeploy && process.stdin.isTTY) {
        const actions = availableActions(reconciled, baseline, schemas, a.removeUnblessed);
        if (actions.accept || actions.revert) {
          const options = [{ value: 'nothing', label: 'Nothing (keep exit code 1)' }];
          if (actions.accept)
            options.push({
              value: 'accept',
              label: 'Accept — bless current state into the baseline',
            });
          if (actions.revert)
            options.push({
              value: 'revert',
              label: 'Revert — write the desired values back to AWS',
            });
          const choice = await select({
            message: `${stackName}: drift found — what do you want to do?`,
            options,
            initialValue: 'nothing',
          });
          if (!isCancel(choice) && choice === 'accept') {
            // accept blesses UNDECLARED only; warn if declared/deleted drift remains
            if (reconciled.some((f) => f.tier === 'declared' || f.tier === 'deleted'))
              console.error(
                `note: ${stackName}: accept blesses the undeclared state only — declared/deleted drift remains (fix the code or choose Revert).`
              );
            const wrote = await acceptStack({
              stackName,
              region,
              desired,
              findings: applyIgnores(findings, stackName, config),
              yes: a.yes,
            });
            if (wrote) {
              // re-evaluate exit WITHOUT re-querying AWS: re-apply the new baseline to
              // the findings we already have (ignores re-applied so the exit matches).
              const nb = await loadBaseline(stackName, desired.accountId, region);
              const reEvaluated = applyIgnores(
                applyBaseline(findings, nb, {
                  declaredByLogical: declaredKeysByLogical(desired.resources),
                }),
                stackName,
                config
              );
              code = exitCode(reEvaluated, a.failOn);
            }
          } else if (!isCancel(choice) && choice === 'revert') {
            const outcome = await revertStack({
              stackName,
              region,
              gathered: { desired, findings, schemas },
              baseline,
              config,
              dryRun: false,
              yes: a.yes,
              removeUnblessed: a.removeUnblessed,
            });
            // R30: an aborted confirm did NOT write to AWS, so the drift still
            // stands — keep the pre-revert exit 1 (symmetric with "Nothing").
            code = resolveInteractiveRevertExit(code, outcome);
          }
        }
      }
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

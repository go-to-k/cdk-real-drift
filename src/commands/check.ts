// `cdkrd check [<stack>...] [--region r] [--profile p] [--app ...] [-c k=v]
//             [--json] [--fail] [--show-all]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a stack with an accepted baseline reports CLEAN.
// Exit (R53, the `cdk diff --fail` convention): report-only by default — drift
// exits 0 (a hint names --fail); with --fail drift exits 1 and prompts are
// suppressed. Errors always exit 2. The exit is the worst across all checked
// stacks.
import { isCancel, select } from '@clack/prompts';
import { isStackNotDeployed } from '../aws-errors.js';
import {
  applyBaseline,
  buildAccepted,
  checkBaselineAccount,
  declaredKeysByLogical,
  loadBaseline,
  warnBaselineSchemaV1,
  warnTemplateHashDrift,
  writeBaseline,
} from '../baseline/baseline-file.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { report, stackSeparator } from '../report/report.js';
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
// undeclared tier (and its `generated` sibling — an undeclared-side classification)
// is meaningless against a synth (not deployed) declared set, so it is excluded.
// --declared-only reuses the same filter against the DEPLOYED template (R59).
// Exported (pure) so the contract is unit-tested.
export function preDeployFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.tier !== 'undeclared' && f.tier !== 'generated');
}

// --undeclared-only (R59): the declared-side comparison is delegated to
// `cdk drift` / CFn drift detection, so declared findings AND the
// declared-comparison byproducts (readGap = declared-but-unreadable,
// unresolved = declared-but-GetAtt) drop out. `deleted` stays — a gone resource
// has no undeclared values to check, and hiding it would be a lie. Exported
// (pure) so the contract is unit-tested.
export function undeclaredOnlyFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) => f.tier !== 'declared' && f.tier !== 'readGap' && f.tier !== 'unresolved'
  );
}

// The first-run (no-baseline) prompt (R45). The old Yes/No confirm hid the two
// facts the decision hinges on: HOW MANY values "Yes" would accept sight-unseen,
// and that "No" is not a dead end (the report prints first and a selective
// accept is offered right after it). A select carries both in the option labels
// themselves; Accept-ALL is first/default since R52 (see the options comment).
// Exported (pure) so the wording contract is unit-tested.
//
// Wording (R49): "undeclared" must be anchored — it means "not declared in YOUR
// deployed (CDK/CloudFormation) template"; there is no cdkrd-side template, and
// the baseline only filters which of these get REPORTED. The count is also NOT
// a drift count: on a first run these are typically AWS defaults the template
// never pinned (with any real out-of-band edits hiding among them), so the
// message says so instead of reading as "N problems found".
//
// declaredDriftCount (R51): a user whose out-of-band edit hit a DECLARED
// property sees a prompt that only talks about NOT-declared values and reads it
// as "the tool missed my change". When declared-side drift exists (declared or
// deleted tier — both are reported regardless of the baseline decision), say so
// explicitly instead of the generic "either way" clause.
export function firstRunPrompt(
  stackName: string,
  recordableCount: number,
  atDefaultCount = 0,
  declaredDriftCount = 0
): { message: string; options: { value: 'show' | 'acceptAll'; label: string }[] } {
  const declaredNote =
    declaredDriftCount > 0
      ? `Also found ${declaredDriftCount} declared-side drift(s) — reported below whichever you choose.`
      : 'Declared-side drift is reported either way.';
  // The "found N" count is the COMPLETE undeclared inventory (R86): the values that
  // actually diverge PLUS the ones sitting at a known AWS default. The at-default
  // remainder is folded in the report, so name it here too instead of letting the
  // user wonder why "found 113" but only a couple are listed. Accept records only the
  // recordable (diverging) ones — at-default values are held by the equality gate.
  const total = recordableCount + atDefaultCount;
  const split =
    atDefaultCount > 0
      ? `${atDefaultCount} sit at a known AWS default (folded below); ${recordableCount} look like real out-of-band edits`
      : 'typically AWS defaults, but out-of-band edits hide among them';
  return {
    message: `${stackName}: no baseline yet — found ${total} live value(s) not declared in your template (${split}). ${declaredNote} What do you want to do?`,
    // Accept-ALL first (R52, user decision): it is the overwhelmingly common
    // first-run choice, and the cost of an accidental Enter is one git-tracked
    // file — reviewable and revertible, nothing written to AWS. "Show first"
    // stays one arrow away for the careful path.
    options: [
      {
        value: 'acceptAll',
        label: `Accept ALL ${recordableCount} into the baseline now, without reviewing them`,
      },
      {
        value: 'show',
        label: 'Show them first — you can still accept (selectively) right after the report',
      },
    ],
  };
}

/**
 * Closing note after an interactive accept inside `check` (R52). A PARTIAL
 * accept used to end with `baseline written: ...` and a silent failure-looking
 * exit. State plainly what remains; the exit story itself is R53's: check is
 * report-only (exit 0 on drift) unless --fail, and the interactive prompts
 * never fire in fail mode, so this note never coexists with a drift exit.
 */
export function postAcceptNote(remainingUndeclared: number, remainingDeclared: number): string {
  if (remainingDeclared > 0) {
    const alsoUndeclared =
      remainingUndeclared > 0
        ? ` ${remainingUndeclared} unaccepted value(s) also stay reported.`
        : '';
    return `accept succeeded, but ${remainingDeclared} declared/deleted drift(s) remain un-addressed (fix the code or choose Revert).${alsoUndeclared}`;
  }
  if (remainingUndeclared > 0)
    return `accept succeeded — ${remainingUndeclared} unaccepted value(s) stay reported from the next check on.`;
  return 'stack is now CLEAN.';
}

/**
 * Map a stack's drift code to check's final exit (R53, the `cdk diff --fail` /
 * `cdk drift --fail` convention): without --fail, check is REPORT-ONLY — drift
 * (1) exits 0; errors (2) always propagate. With --fail, drift exits 1. Pure + exported for tests.
 */
export function finalCheckExit(code: number, fail: boolean): number {
  return fail || code !== 1 ? code : 0;
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

  let stacks;
  try {
    stacks = await resolveStacks(a);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  if (stacks.length === 0) {
    console.error('note: the CDK app defines no stacks — nothing to check');
    return 0;
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
  let anyDrift = false; // for the report-only hint (R53)
  // R37: one blank line between consecutive stack reports (text mode only) — done
  // here at the call site so a single-stack run never gets a stray leading blank.
  const separate = stackSeparator();
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
      const gathered = await gatherFindings(stackName, region, synthTemplates?.get(stackName));
      const { desired, schemas } = gathered;
      let findings = gathered.findings;

      // Scope flags (R59). --undeclared-only delegates the declared side to
      // `cdk drift` / CFn drift detection (no double reporting when pairing);
      // --declared-only is the inverse (undeclared tier skipped, baseline
      // untouched) — unlike --pre-deploy, it compares against the DEPLOYED
      // template. Filtering up front keeps everything downstream consistent:
      // first-run prompt counts, baseline notes, interactive actions, reverts.
      if (a.undeclaredOnly) {
        findings = undeclaredOnlyFindings(findings);
        if (!a.json)
          console.error(
            `note: ${stackName}: --undeclared-only — declared-side drift is not compared (pair with cdk drift / CFn drift detection)`
          );
      }
      if (a.declaredOnly) {
        findings = preDeployFindings(findings); // same filter: drop the undeclared tier
        if (!a.json)
          console.error(
            `note: ${stackName}: --declared-only — undeclared values are not compared (baseline untouched)`
          );
      }

      // --pre-deploy: the declared set comes from the LOCAL synth template, so the
      // ONLY meaningful signal is declared drift the next deploy would clobber. The
      // undeclared tier is "live minus declared" — with a synth declared set its
      // meaning silently shifts, so we drop it and do NOT touch the baseline at all
      // (no accept offer, no baseline load — which would also wrongly hash the synth
      // template). See ARCHITECTURE §13-2.
      if (a.preDeploy) {
        const declaredOnly = preDeployFindings(findings);
        if (!a.json)
          console.error(
            `note: ${stackName}: --pre-deploy reports declared drift only (undeclared tiers are evaluated against the deployed template — run check without --pre-deploy)`
          );
        if (!a.json) separate();
        const preDeployCode = report(
          applyIgnores(declaredOnly, stackName, config),
          `${stackName} (${region})`,
          {
            json: a.json,
            verbose: a.verbose,
          }
        );
        if (preDeployCode === 1) anyDrift = true;
        worst = Math.max(worst, finalCheckExit(preDeployCode, a.fail));
        continue;
      }

      let baseline = a.showAll
        ? undefined
        : await loadBaseline(stackName, desired.accountId, region);
      // per-account guard: a baseline captured in a different account is wrong here
      if (baseline) checkBaselineAccount(baseline, desired.accountId, stackName);
      // stale-baseline warning (pre-deploy already returned above, so always safe here)
      if (baseline) warnTemplateHashDrift(baseline, desired.rawTemplate, stackName);
      // schema-v1 baseline: no completeResources — appeared-since-accept values
      // read as unrecorded until the next accept upgrades the file (R62)
      if (baseline && !a.json) warnBaselineSchemaV1(baseline, stackName);
      // First run: no baseline yet → choose between "report first" (the safe
      // default — a selective accept is offered again right after the report) and
      // a bulk accept of everything sight-unseen (R45). Ignore rules are applied
      // BEFORE counting/accepting so the bulk path can never accept values the
      // report would have re-tagged as ignored (same as the post-report accept).
      // With ZERO undeclared values there is no decision worth interrupting for —
      // no prompt (`cdkrd accept` still writes a baseline for a clean stack).
      if (!baseline && !a.showAll && !a.json && !a.fail && isInteractive()) {
        const acceptable = applyIgnores(findings, stackName, config);
        // recordable = real diverging undeclared values (what accept records); the
        // atDefault tier is folded inventory, never recorded (R86). Prompt only when
        // there is something to record — a stack whose only undeclared values are at
        // their AWS default is reported (CLEAN + folded info), not interrupted.
        const recordableCount = acceptable.filter((f) => f.tier === 'undeclared').length;
        const atDefaultCount = acceptable.filter((f) => f.tier === 'atDefault').length;
        const declaredDriftCount = acceptable.filter(
          (f) => f.tier === 'declared' || f.tier === 'deleted'
        ).length;
        if (recordableCount > 0) {
          const prompt = firstRunPrompt(
            stackName,
            recordableCount,
            atDefaultCount,
            declaredDriftCount
          );
          const choice = await select({
            message: prompt.message,
            options: prompt.options,
            initialValue: 'acceptAll' as const,
          });
          if (!isCancel(choice) && choice === 'acceptAll') {
            const { count } = await writeBaseline(
              stackName,
              region,
              desired.accountId,
              acceptable,
              desired.rawTemplate,
              buildAccepted(acceptable),
              // full resource list so read-clean resources are snapshot-complete too (R62)
              { allLogicalIds: desired.resources.map((r) => r.logicalId) }
            );
            console.error(`baseline written (${count} undeclared value(s) accepted) — commit it.`);
            baseline = await loadBaseline(stackName, desired.accountId, region);
          }
        }
      }
      // applyBaseline classifies per ENTRY (R62): matching entries are suppressed,
      // changed values are drift, entry-less values are drift only on a
      // snapshot-complete resource (appeared since accept) and UNRECORDED
      // otherwise — including the whole no-baseline first run (R60). The report
      // renders unrecorded values as [UNRECORDED: N], excludes them from the
      // verdict/exit, and points at `cdkrd accept` on the result line.
      // --show-all keeps its raw inventory semantics: the baseline is bypassed
      // entirely (no suppression, no unrecorded tagging). --declared-only also
      // bypasses it ("undeclared values are not compared"): with the undeclared
      // tier filtered out, applyBaseline's removal pass would mis-read EVERY
      // accepted entry as `baseline value removed since accept` (latent in R59).
      const reconciled = applyIgnores(
        a.showAll || a.declaredOnly
          ? findings
          : applyBaseline(findings, baseline, {
              declaredByLogical: declaredKeysByLogical(desired.resources),
              warn: (s: string) => {
                if (!a.json) console.error(s);
              },
            }),
        stackName,
        config
      );
      if (!a.json) separate();
      let code = report(reconciled, `${stackName} (${region})`, {
        json: a.json,
        verbose: a.verbose,
        // --show-all is inventory mode: list every undeclared value, including the
        // ones at an AWS default (otherwise folded to a count) (R86).
        expandAtDefault: a.showAll,
      });
      const hasUnrecorded = reconciled.some((f) => f.unrecorded === true);

      // R28: drift found in a TTY → offer accept / revert / nothing inline, instead
      // of making the user re-run a separate command. Skipped for --json (machine
      // output), --show-all (baseline not applied — accept would mean something else),
      // and --pre-deploy (declared-only, baseline-untouched contract). UNRECORDED
      // values do not set code 1 (R60) but still deserve the prompt — "show them
      // first" promises a selective accept right after the report.
      if (
        (code === 1 || hasUnrecorded) &&
        !a.json &&
        !a.showAll &&
        !a.preDeploy &&
        !a.fail &&
        isInteractive()
      ) {
        const actions = availableActions(reconciled, baseline, schemas, a.removeUnaccepted);
        if (actions.accept || actions.revert) {
          const options = [{ value: 'nothing', label: 'Nothing (decide later)' }];
          if (actions.accept)
            options.push({
              value: 'accept',
              label: 'Accept — record current state into the baseline',
            });
          if (actions.revert)
            options.push({
              value: 'revert',
              label: 'Revert — write the desired values back to AWS',
            });
          const choice = await select({
            message:
              code === 1
                ? `${stackName}: drift found — what do you want to do?`
                : `${stackName}: unrecorded values found — what do you want to do?`,
            options,
            initialValue: 'nothing',
          });
          if (!isCancel(choice) && choice === 'accept') {
            // accept records UNDECLARED only; warn if declared/deleted drift remains
            if (reconciled.some((f) => f.tier === 'declared' || f.tier === 'deleted'))
              console.error(
                `note: ${stackName}: accept records the undeclared state only — declared/deleted drift remains (fix the code or choose Revert).`
              );
            const result = await acceptStack({
              stackName,
              region,
              desired,
              findings: applyIgnores(findings, stackName, config),
              yes: a.yes,
              interactive: isInteractive(),
            });
            if (result.wrote) {
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
              // R52 (user decision): a successful interactive accept is a SUCCESS
              // for THIS run — deliberately-unselected undeclared values do not
              // fail this exit (they surface from the next check on; this path is
              // TTY-only so no CI contract is touched). Declared/deleted drift is
              // outside accept's reach and keeps exit 1.
              const remainingDeclared = reEvaluated.filter(
                (f) => f.tier === 'declared' || f.tier === 'deleted'
              ).length;
              const remainingUndeclared = reEvaluated.filter((f) => f.tier === 'undeclared').length;
              code = remainingDeclared > 0 ? 1 : 0;
              console.error(
                `note: ${stackName}: ${postAcceptNote(remainingUndeclared, remainingDeclared)}`
              );
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
              removeUnaccepted: a.removeUnaccepted,
              verbose: a.verbose,
              interactive: isInteractive(),
            });
            // R30: an aborted confirm did NOT write to AWS, so the drift still
            // stands — keep the pre-revert exit 1 (symmetric with "Nothing").
            code = resolveInteractiveRevertExit(code, outcome);
          }
        }
      }
      if (code === 1) anyDrift = true;
      worst = Math.max(worst, finalCheckExit(code, a.fail));
    } catch (e) {
      if (isStackNotDeployed(e)) {
        console.error(`note: ${stackName}: not deployed yet — skipped`);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  // Report-only mode found drift: say so, and say how to make it fail — a script
  // author piping this must discover --fail from the output, not from a surprise
  // green pipeline (R53). Suppressed under --json (machine consumers read stdout).
  if (anyDrift && !a.fail && !a.json) {
    console.error(
      'note: drift found — exit 0 (report-only). Pass --fail to make drift fail this command.'
    );
  }
  return worst;
}

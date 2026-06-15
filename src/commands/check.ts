// `cdkrd check [<stack>...] [--region r] [--profile p] [--app ...] [-c k=v]
//             [--json] [--fail] [--show-all]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a stack with an recorded baseline reports CLEAN.
// Exit (R53, the `cdk diff --fail` convention): report-only by default — drift
// exits 0 (a hint names --fail); with --fail drift exits 1 and prompts are
// suppressed. Errors always exit 2. The exit is the worst across all checked
// stacks.
import { isStackNotDeployed } from '../aws-errors.js';
import {
  applyBaseline,
  checkBaselineAccount,
  declaredKeysByLogical,
  loadBaseline,
  warnBaselineSchemaV1,
  warnTemplateHashDrift,
} from '../baseline/baseline-file.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { report, stackSeparator } from '../report/report.js';
import { resolveApp } from '../synth/resolve-app.js';
import { synthApp } from '../synth/synth.js';
import type { Finding } from '../types.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import { resolveInteractively } from './interactive-resolve.js';

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
      const { desired, schemas, liveByLogical } = gathered;
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
      // (no record offer, no baseline load — which would also wrongly hash the synth
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

      const baseline = a.showAll
        ? undefined
        : await loadBaseline(stackName, desired.accountId, region);
      // per-account guard: a baseline captured in a different account is wrong here
      if (baseline) checkBaselineAccount(baseline, desired.accountId, stackName);
      // stale-baseline warning (pre-deploy already returned above, so always safe here)
      if (baseline) warnTemplateHashDrift(baseline, desired.rawTemplate, stackName);
      // schema-v1 baseline: no completeResources — appeared-since-record values
      // read as unrecorded until the next record upgrades the file (R62)
      if (baseline && !a.json) warnBaselineSchemaV1(baseline, stackName);
      // First run (no baseline): R110 removed the pre-report "Record ALL sight-unseen"
      // prompt (R45/R52). It buried the very values it flagged as possible out-of-band
      // edits — pressing Enter recorded them into the baseline BEFORE the user ever saw
      // them, and the report then suppressed them, so a real edit could vanish in one
      // keystroke. Now the report ALWAYS prints first; the post-report prompt below
      // ("unrecorded values found — Record/Revert/Nothing") offers a SELECTIVE record
      // after the user has seen the standout values. Folding (atDefault/generated/
      // nested) keeps that list short, so the old bulk-record-to-avoid-scrolling
      // rationale no longer applies. `cdkrd record` still writes a baseline directly.
      // applyBaseline classifies per ENTRY (R62): matching entries are suppressed,
      // changed values are drift, entry-less values are drift only on a
      // snapshot-complete resource (appeared since record) and UNRECORDED
      // otherwise — including the whole no-baseline first run (R60). The report
      // renders unrecorded values as [UNRECORDED: N], excludes them from the
      // verdict/exit, and points at `cdkrd record` on the result line.
      // --show-all keeps its raw inventory semantics: the baseline is bypassed
      // entirely (no suppression, no unrecorded tagging). --declared-only also
      // bypasses it ("undeclared values are not compared"): with the undeclared
      // tier filtered out, applyBaseline's removal pass would mis-read EVERY
      // recorded entry as `baseline value removed since record` (latent in R59).
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

      // R28 (extended R121): drift found in a TTY → offer to resolve it inline
      // (Record all / Revert all / Ignore all / Decide per finding / Nothing) instead
      // of making the user re-run a separate verb. Skipped for --json (machine output),
      // --show-all (baseline not applied — record would mean something else), and
      // --pre-deploy (declared-only, baseline-untouched contract). UNRECORDED values do
      // not set code 1 (R60) but still deserve the prompt. The whole resolution flow
      // lives in interactive-resolve.ts; it returns the re-evaluated exit code.
      if (
        (code === 1 || hasUnrecorded) &&
        !a.json &&
        !a.showAll &&
        !a.preDeploy &&
        !a.fail &&
        isInteractive()
      ) {
        code = await resolveInteractively({
          stackName,
          region,
          desired,
          findings,
          reconciled,
          baseline,
          schemas,
          liveByLogical,
          config,
          code,
          yes: a.yes,
          removeUnrecorded: a.removeUnrecorded,
          verbose: a.verbose,
        });
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

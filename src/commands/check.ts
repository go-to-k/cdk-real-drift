// `cdkrd check [<stack>...] [--region r] [--profile p] [--app ...] [-c k=v]
//             [--json] [--fail] [--show-all]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a stack with an recorded baseline reports CLEAN.
// Exit (R53, the `cdk diff --fail` convention): report-only by default — drift
// exits 0 (a hint names --fail); with --fail drift exits 1 and prompts are
// suppressed. Errors always exit 2. The exit is the worst across all checked
// stacks.
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isStackNotDeployed, StackNotCheckableError } from '../aws-errors.js';
import {
  applyBaseline,
  type ApplyBaselineOptions,
  type BaselineFile,
  baselinePath,
  checkBaselineAccount,
  constructPathsByLogical,
  declaredKeysByLogical,
  loadBaseline,
  physicalIdsByLogical,
  warnBaselineSchemaV1,
  warnTemplateHashDrift,
} from '../baseline/baseline-file.js';
import { isInteractive, parseCommonArgs } from '../cli-args.js';
import { applyIgnores, loadConfig } from '../config/config-file.js';
import { withinStackPath } from '../construct-path.js';
import {
  buildStackJson,
  deletedStackReport,
  report,
  type StackJsonReport,
  stackSeparator,
} from '../report/report.js';
import { style } from '../report/style.js';
import { resolveApp } from '../synth/resolve-app.js';
import { synthApp } from '../synth/synth.js';
import type { DesiredResource, Finding } from '../types.js';
import { resolveStacks } from './resolve-stacks.js';
import { gatherFindings } from './gather.js';
import {
  gatherWithProgress,
  positionPrefix,
  progressLabel,
  stackCountAnnouncement,
} from './progress.js';
import { resolveInteractively } from './interactive-resolve.js';

// --pre-deploy reports declared-side drift the next deploy would clobber; the
// undeclared tier AND its undeclared-side siblings (`generated` and `atDefault` —
// both classified only in classify's undeclared loops) are meaningless against a
// synth (not deployed) declared set, so all three are excluded. --declared-only
// reuses the same filter against the DEPLOYED template (R59) — its "undeclared
// values are not compared" contract must hold for the `atDefault` footer too, else
// Key a synth template by stack name + region (a CFn stack name is region-scoped, so
// the same name can recur across regions in one app). Exported (pure) for unit testing.
export function synthKey(stackName: string, region: string | undefined): string {
  return `${stackName}\0${region ?? ''}`;
}

// Reconcile classified findings against the baseline for the report. Exported (pure)
// so the --show-all contract below is unit-tested.
//
// `--declared-only` is the ONLY mode that bypasses applyBaseline: it filters the
// undeclared tier out entirely, so applyBaseline's removal pass would misread EVERY
// recorded entry as "baseline value removed since record" (latent in R59).
//
// `--show-all` (inventory mode) does NOT bypass it. The caller already loaded
// `baseline = undefined` for show-all (it lists ALL current undeclared state,
// ignoring whatever is recorded), and applyBaseline(findings, undefined) is exactly
// the path that tags every undeclared/added value `unrecorded` — i.e. POTENTIAL
// drift, not confirmed drift. Bypassing it (the pre-#378 behavior) left those values
// untagged, so the report mislabeled a fresh deploy's live-only inventory as
// "CFn-Undeclared Drift" / "N drift(s)" and `--show-all --fail` exited 1 on a stack
// nobody had touched — the first-run false-drift the Potential Drift model removed.
export function reconcileBaseline(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  opts: { declaredOnly: boolean; applyOpts: ApplyBaselineOptions }
): Finding[] {
  if (opts.declaredOnly) return findings;
  return applyBaseline(findings, baseline, opts.applyOpts);
}

// `--declared-only` still prints an `At AWS Default (N)` line for values it claims
// not to compare. Exported (pure) so the contract is unit-tested.
export function preDeployFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) =>
      f.tier !== 'undeclared' &&
      f.tier !== 'generated' &&
      f.tier !== 'atDefault' &&
      // `added` is a LIVE-only divergence (a resource not in the template) — the
      // declared-side / pre-deploy view is about template-declared props, and a deploy
      // won't remove an out-of-band resource, so it belongs with the undeclared side.
      f.tier !== 'added'
  );
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

// A nested CloudFormation stack (the CDK `NestedStack` construct, or any plain
// `AWS::CloudFormation::Stack` resource) is deployed as a SEPARATE child stack whose
// own resources are the real infrastructure. cdkrd checks the PARENT's
// `AWS::CloudFormation::Stack` resource (its TemplateURL / Parameters) via Cloud
// Control, but does NOT recurse into the child stack — so the child's resources
// (buckets, roles, …) are never checked. A drift tool silently under-covering is the
// danger: a CLEAN verdict that never looked inside the nested stack reads as
// fully-checked. Surface the gap LOUDLY so coverage is never silently incomplete.
// Returns the warning line, or null when the stack has no nested stacks. Pure +
// exported for unit tests.
export function nestedStackWarning(resources: DesiredResource[], stackName: string): string | null {
  const nested = resources.filter((r) => r.resourceType === 'AWS::CloudFormation::Stack');
  if (nested.length === 0) return null;
  const names = nested
    .map((r) => (r.constructPath ? withinStackPath(r.constructPath, stackName) : r.logicalId))
    .sort();
  return `warning: ${stackName} has ${nested.length} nested CloudFormation stack(s) — cdkrd does not recurse into them, so the resources INSIDE them are NOT checked: ${names.join(', ')}`;
}

// #727: under --pre-deploy the declared source is the LOCAL synth template, so a
// resource that exists there but has not been deployed yet legitimately has NO physical
// id. gather.ts emits `skipped: no physical id` for it (correct on the deployed path,
// where a missing physical id is a real anomaly — cf. #689), but under --pre-deploy this
// is EXPECTED, not a coverage gap: the next deploy will create it. This predicate matches
// ONLY that exact skip reason (note === 'no physical id'), so other skips — CC-unsupported,
// read errors — remain genuine coverage gaps even under --pre-deploy. Pure + exported.
export function isPendingCreationSkip(f: Finding): boolean {
  return f.tier === 'skipped' && f.note === 'no physical id';
}

// Resources cdkrd could NOT read this run land in the `skipped` tier — a
// CC-unsupported type with no SDK override, a read error (throttle / AccessDenied), a
// missing physical id, a Custom resource. They are genuinely UNCHECKED, yet `skipped`
// is excluded from the verdict and from `--fail`, and only folded into the `info:`
// footer — so a materially under-covered run can read `result: CLEAN`, exit 0. Surface
// the gap LOUDLY (same not-silent principle as the nested-stack / KMS warnings); the
// `--strict` flag additionally turns it into a non-zero exit. Returns null when nothing
// was skipped. Under --pre-deploy (#727) a "no physical id" skip is a not-yet-deployed
// local resource, not a gap — excluded here so it is not warned as under-coverage. Pure
// + exported for unit tests.
export function coverageWarning(
  findings: Finding[],
  stackName: string,
  preDeploy = false
): string | null {
  const skipped = findings.filter(
    (f) => f.tier === 'skipped' && !(preDeploy && isPendingCreationSkip(f))
  );
  if (skipped.length === 0) return null;
  const names = skipped
    .map((f) => (f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId))
    .sort();
  const shown = names.slice(0, 10);
  const more = names.length > shown.length ? `, …(+${names.length - shown.length} more)` : '';
  return `warning: ${stackName}: ${skipped.length} resource(s) were NOT checked (coverage incomplete) — ${shown.join(', ')}${more}; see the skipped breakdown (--verbose)`;
}

// #727: under --pre-deploy, the informational count of local resources that are not yet
// deployed (a "no physical id" skip) — they will be created by the next deploy, so they
// are surfaced as info, NOT a coverage gap. Returns the info line, or null when none.
// Pure + exported for unit tests.
export function pendingCreationInfo(findings: Finding[], stackName: string): string | null {
  const pending = findings.filter(isPendingCreationSkip);
  if (pending.length === 0) return null;
  const names = pending
    .map((f) => (f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId))
    .sort();
  const shown = names.slice(0, 10);
  const more = names.length > shown.length ? `, …(+${names.length - shown.length} more)` : '';
  return `info: ${stackName}: ${pending.length} resource(s) not yet deployed — will be created by the next deploy (pending creation, not a coverage gap): ${shown.join(', ')}${more}`;
}

// The coverage gap that `--strict` fails on: any resource skipped (unread) OR any
// nested stack not recursed into. Under --pre-deploy (#727) a "no physical id" skip is a
// not-yet-deployed local resource (pending creation), which is EXPECTED and therefore not
// a gap — excluded so `--strict --pre-deploy` no longer false-fails on a feature branch
// that merely ADDS a resource with zero real drift. Non-pre-deploy behavior is unchanged.
// Pure + exported.
export function hasCoverageGap(
  findings: Finding[],
  resources: DesiredResource[],
  preDeploy = false
): boolean {
  return (
    findings.some((f) => f.tier === 'skipped' && !(preDeploy && isPendingCreationSkip(f))) ||
    resources.some((r) => r.resourceType === 'AWS::CloudFormation::Stack')
  );
}

// The exit contribution of `--strict`: a coverage gap is a non-zero exit
// independent of --fail's drift axis. Returns 1 when --strict is set AND coverage
// is incomplete, else 0. Pure + exported so BOTH the normal and the --pre-deploy
// path fold the identical value into `worst` — the --pre-deploy branch returns
// early (its own report + continue), so without sharing this it silently never
// applied --strict (a skipped resource / un-recursed nested stack under
// --strict --pre-deploy exited 0). Under --pre-deploy (#727) a "no physical id"
// skip (a not-yet-deployed local resource) does not count as a gap.
export function strictCoverageExit(
  strict: boolean,
  findings: Finding[],
  resources: DesiredResource[],
  preDeploy = false
): number {
  return strict && hasCoverageGap(findings, resources, preDeploy) ? 1 : 0;
}

/**
 * Map a stack's drift code to check's final exit (R53, the `cdk diff --fail` /
 * `cdk drift --fail` convention): without --fail, check is REPORT-ONLY — drift
 * (1) exits 0; errors (2) always propagate. With --fail, drift exits 1. Pure + exported for tests.
 */
export function finalCheckExit(code: number, fail: boolean): number {
  return fail || code !== 1 ? code : 0;
}

/**
 * #781: does a committed baseline exist for this stack IN THE REGION being checked?
 * A committed baseline is named `<stackName>.<accountId>.<region>.json` under
 * `.cdkrd/baselines/`. The gone stack's ACCOUNT is unknown without an STS call, so it
 * stays wildcarded; but the REGION being checked IS known (the loop's `region`), and a
 * baseline recorded for THIS stack in THIS region carries exactly that region in its
 * filename — so we require the `.<region>.json` suffix. A prior baseline in this region
 * is PROOF the stack was once deployed THERE, which distinguishes "deleted out of band"
 * (real drift) from "never deployed yet" (a benign skip). Without the region gate, a
 * same-named stack that was never deployed in region B but has a baseline in region A is
 * falsely reported "deleted out of band" (#942).
 *
 * #986: the match is CASE-INSENSITIVE (both sides lowercased) so it answers consistently
 * with `loadBaseline`, whose `readFile` opens the file case-insensitively on macOS/Windows.
 * A case-sensitive `readdirSync` prefix would MISS a baseline committed as `mystack.….json`
 * when checking `MyStack`, silently downgrading a genuinely deleted stack to a benign skip.
 *
 * The baselines directory is derived from `baselinePath` so the layout stays single-sourced.
 * Pure (filesystem-only, no AWS) + exported for unit tests. Missing dir → false.
 */
export function hasBaselineForStack(stackName: string, region: string): boolean {
  const dir = dirname(baselinePath(stackName, 'a', 'r'));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false; // no `.cdkrd/baselines/` directory at all → nothing was ever recorded
  }
  const prefix = `${stackName}.`.toLowerCase();
  const suffix = `.${region}.json`.toLowerCase();
  return entries.some((f) => {
    const lower = f.toLowerCase();
    return lower.startsWith(prefix) && lower.endsWith(suffix);
  });
}

export async function runCheck(args: string[]): Promise<number> {
  const a = parseCommonArgs(args, 'check');
  if (a.profile) process.env.AWS_PROFILE = a.profile; // honored by SDK clients + synth subprocess

  // .cdkrd/ignore.yaml ignore rules, loaded once (cwd-relative). A malformed config
  // fails the whole run fast — a silently-ineffective ignore rule is the dangerous case.
  // A whole-run failure BEFORE any stack is known (bad config, un-synthesizable app, a
  // zero-stack app) still exits non-zero — but under --json it must leave stdout a single
  // JSON.parse-able value, not empty. Emit `[]` (no stacks reached) so a consumer's
  // JSON.parse(stdout) succeeds and it reads the failure from the exit code + stderr,
  // instead of throwing on '' (#871 — the top-level twin of the #885 zero-stack fix).
  const emitEmptyJsonOnError = (): void => {
    if (a.json) console.log('[]');
  };

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    emitEmptyJsonOnError();
    return 2;
  }

  let stacks;
  try {
    stacks = await resolveStacks(a);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    emitEmptyJsonOnError();
    return 2;
  }
  if (stacks.length === 0) {
    // Under --json the whole stdout stream is a single JSON.parse-able value (an
    // array of per-stack reports, printed once at the end). The zero-stack early
    // return happens BEFORE that print, so without this a consumer's
    // JSON.parse(stdout) throws on '' while the exit code reads success (#885).
    // Emit the empty array to keep the contract; the human note stays on stderr.
    if (a.json) console.log('[]');
    else console.error('note: the CDK app defines no stacks — nothing to check');
    return 0;
  }

  // Announce the total up front (issue #539): in a multi-stack run each stack prints its
  // report + interactive prompt one at a time, so without this the count only ever shows
  // embedded in the scrolled-away `[i/N]` spinner line. To stderr (never pollutes --json
  // stdout) and suppressed under --json; a lone stack gets nothing (stackCountAnnouncement
  // returns null — consistent with the `[1/1]`-is-noise rule).
  if (!a.json) {
    const announce = stackCountAnnouncement(stacks.map((s) => s.stackName));
    if (announce) console.error(announce);
  }

  // --pre-deploy: synth the local app once and use each stack's synth template as
  // the declared source, so check reports the declared drift the next deploy would
  // overwrite (clobber) rather than comparing against the already-deployed template.
  let synthTemplates: Map<string, Record<string, unknown>> | undefined;
  if (a.preDeploy) {
    const app = resolveApp(a.app);
    if (!app) {
      console.error('error: --pre-deploy needs a CDK app (--app or a cdk.json in the cwd)');
      emitEmptyJsonOnError();
      return 2;
    }
    let synthed;
    try {
      synthed = await synthApp(app, {
        region: a.region,
        profile: a.profile,
        context: a.context,
        // Refuse (not just warn) an assembly with unresolved context lookups here: under
        // --pre-deploy the synth template is the DECLARED source, so CDK's dummy-value
        // placeholders (vpc-12345, ...) would surface as guaranteed false declared drift
        // and a revert would write them back to AWS (#907).
        preDeploy: true,
      });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      emitEmptyJsonOnError();
      return 2;
    }
    // Key by stackName + region, NOT stackName alone: a stack name is region-scoped in
    // CloudFormation, so an app can define two same-named stacks in different regions.
    // Keyed by name alone, the second would overwrite the first and BOTH would then be
    // compared against the wrong (last-synthesized) template. The region resolution
    // mirrors resolveStacks (`s.region ?? a.region`) so the loop's lookup key matches.
    synthTemplates = new Map(
      synthed.map((s) => [synthKey(s.stackName, s.region ?? a.region), s.template])
    );
    console.error('(--pre-deploy) comparing live state against the LOCAL synth template');
  }

  let worst = 0;
  let anyDrift = false; // for the report-only hint (R53)
  // #755: in --json mode each stack's report object is COLLECTED here and a single
  // top-level JSON ARRAY (one element per stack) is printed once, after the loop —
  // instead of each stack's report() printing its own pretty-printed object inline,
  // which concatenated into `{...}\n{...}` (not one parseable JSON value, not JSONL).
  // A stack that ERRORED / was skipped still gets an element (with an `error` field) so
  // a consumer sees which stacks ran. In text mode this stays empty and unused.
  const jsonReports: StackJsonReport[] = [];
  // Record an errored/skipped stack in the --json output so it is not silently omitted
  // (no-op in text mode, where the reason already goes to stderr).
  const jsonError = (stackName: string, region: string | undefined, message: string): void => {
    if (a.json)
      jsonReports.push({
        stack: region ? `${stackName} (${region})` : stackName,
        drifted: 0,
        findings: [],
        error: message,
      });
  };
  // R37: one blank line between consecutive stack reports (text mode only) — done
  // here at the call site so a single-stack run never gets a stray leading blank.
  const separate = stackSeparator();
  // The gather-phase spinner (see gatherWithProgress) — text mode + TTY only.
  const showProgress = !a.json && isInteractive();
  for (const [idx, { stackName, region, template }] of stacks.entries()) {
    if (!region) {
      const msg =
        'no region — set env on the stack, pass --region, or set a region for the AWS profile';
      console.error(`error: ${stackName}: ${msg}`);
      jsonError(stackName, region, msg);
      worst = Math.max(worst, 2);
      continue;
    }
    // The `[i/N] ` position cue (issue #539) — same gating as the spinner label: only in
    // a multi-stack text run, '' for a lone stack or --json. Threaded into the report
    // header and the interactive prompt so the cue is present where the user reads/decides,
    // not only on the scrolled-away spinner line.
    const posPrefix = a.json ? '' : positionPrefix(idx, stacks.length);
    try {
      const sKey = synthKey(stackName, region);
      if (synthTemplates && !synthTemplates.has(sKey)) {
        console.error(`note: ${stackName}: not in the synth output — skipped (--pre-deploy)`);
        jsonError(stackName, region, 'not in the synth output — skipped (--pre-deploy)');
        // #948: dropping a user-named stack from the run is the MAXIMAL coverage gap —
        // nothing in it was checked — so under --strict it must fail (mirroring the
        // deleted-stack fold below and one skipped RESOURCE already failing --strict).
        // Without --strict, preserve the exit-0 skip.
        worst = Math.max(worst, a.strict ? 1 : 0);
        continue;
      }
      // The stack's synth template (always carried by resolveStacks) is the non-ASCII
      // RECOVERY source for the deployed-template path — loadDesired ignores it under
      // --pre-deploy (where synthTemplates is already the declared override).
      const gathered = await gatherWithProgress(
        showProgress,
        progressLabel(idx, stacks.length, stackName, region),
        () => gatherFindings(stackName, region, synthTemplates?.get(sKey), template)
      );
      const { desired, schemas, liveByLogical } = gathered;
      let findings = gathered.findings;

      // Loudly flag incomplete coverage — a CLEAN verdict must never silently hide an
      // unchecked nested stack or an unread (skipped) resource. To stderr so it survives
      // `--json` (whose machine output is stdout) without polluting it. `--strict` turns
      // any such gap into a non-zero exit (folded into `worst` after the report).
      const nestedWarn = nestedStackWarning(desired.resources, stackName);
      if (nestedWarn) console.error(nestedWarn);
      // Coverage gap (skipped / unread resources): R127 folds this into the report's
      // info: footer for TEXT mode — the `skipped=` line there now carries the "NOT
      // checked (coverage incomplete)" framing, so emitting a separate stderr warning
      // BEFORE the report would (a) bury the drift result below the fold (the very UX
      // complaint that prompted R127) and (b) duplicate the footer. --json has no info:
      // footer, so keep the loud stderr warning there to preserve the invariant.
      if (a.json) {
        const covWarn = coverageWarning(gathered.findings, stackName, a.preDeploy);
        if (covWarn) console.error(covWarn);
      }
      // #727: under --pre-deploy, surface not-yet-deployed local resources (a "no physical
      // id" skip) as INFORMATIONAL — they are excluded from the coverage gap / --strict
      // exit above, so say WHY the count is not a gap (they will be created by the deploy).
      // stderr keeps --json stdout clean.
      if (a.preDeploy) {
        const pendingInfo = pendingCreationInfo(gathered.findings, stackName);
        if (pendingInfo) console.error(pendingInfo);
      }
      // a mid-operation / failed stack state still gets compared, but the result may be
      // transient/unreliable — say so loudly (REVIEW_IN_PROGRESS / deleting states never
      // reach here; loadDesired throws StackNotCheckableError, handled in the catch).
      if (desired.stackStatusWarning)
        console.error(`warning: ${stackName}: ${desired.stackStatusWarning}`);

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
        const preDeployReconciled = applyIgnores(
          declaredOnly,
          { stackName, accountId: desired.accountId, region },
          config
        );
        const preDeployHeader = `${posPrefix}${stackName} (${region})`;
        // #755: in --json collect the stack's object (printed as one array at the end);
        // in text mode render inline as before.
        let preDeployCode: number;
        if (a.json) {
          const { json, code } = buildStackJson(preDeployReconciled, preDeployHeader);
          jsonReports.push(json);
          preDeployCode = code;
        } else {
          preDeployCode = report(preDeployReconciled, preDeployHeader, {
            verbose: a.verbose,
          });
        }
        if (preDeployCode === 1) anyDrift = true;
        worst = Math.max(worst, finalCheckExit(preDeployCode, a.fail));
        // --strict still applies under --pre-deploy: live reads (and so the skipped
        // tier / un-recursed nested stacks) happen here too, only the DECLARED side
        // comes from the synth template. Fold the coverage-gap exit BEFORE the early
        // continue, or --strict --pre-deploy would silently never fail. Pass preDeploy so
        // a not-yet-deployed local resource (#727) is pending-creation info, not a gap.
        worst = Math.max(
          worst,
          strictCoverageExit(a.strict, gathered.findings, desired.resources, true)
        );
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
      // read as unrecorded until the next record upgrades the file (R62). Emitted
      // UNCONDITIONALLY to stderr (matching the two sibling warnings above, post-#921):
      // under --json a schema-v1 baseline SHIFTS the classification semantics
      // (appeared-since-record values read as `unrecorded`, excluded from `drifted`), so
      // the --json consumer is exactly who must see it. warnBaselineSchemaV1's sink is
      // `console.error`, so JSON stdout stays pure. The old `!a.json` gate dropped it
      // NOWHERE under --json (#944).
      if (baseline) warnBaselineSchemaV1(baseline, stackName);
      // First run (no baseline): R110 removed the pre-report "Record ALL sight-unseen"
      // prompt (R45/R52). It buried the very values it flagged as possible out-of-band
      // edits — pressing Enter recorded them into the baseline BEFORE the user ever saw
      // them, and the report then suppressed them, so a real edit could vanish in one
      // keystroke. Now the report ALWAYS prints first; the post-report prompt below
      // ("potential drift found — Record/Revert/Nothing") offers a SELECTIVE record
      // after the user has seen the standout values. Folding (atDefault/generated/
      // nested) keeps that list short, so the old bulk-record-to-avoid-scrolling
      // rationale no longer applies. `cdkrd record` still writes a baseline directly.
      // applyBaseline classifies per ENTRY (R62): matching entries are suppressed,
      // changed values are drift, entry-less values are drift only on a
      // snapshot-complete resource (appeared since record) and UNRECORDED
      // otherwise — including the whole no-baseline first run (R60). The report
      // renders unrecorded values as [Potential Drift: N], excludes them from the
      // verdict/exit, and points at `cdkrd record` on the result line.
      // --show-all loaded baseline=undefined above (it lists ALL undeclared state,
      // ignoring what is recorded) but STILL reconciles: applyBaseline(_, undefined)
      // tags every undeclared/added value `unrecorded` (potential drift, not confirmed
      // drift), so a fresh deploy's inventory is not mislabeled as drift and
      // --show-all --fail does not exit 1 on an untouched stack. Only --declared-only
      // bypasses applyBaseline (see reconcileBaseline). R59/R86/#378.
      const reconciled = applyIgnores(
        reconcileBaseline(findings, baseline, {
          declaredOnly: a.declaredOnly,
          applyOpts: {
            declaredByLogical: declaredKeysByLogical(desired.resources),
            constructPathByLogical: constructPathsByLogical(desired.resources),
            physicalIdByLogical: physicalIdsByLogical(desired.resources),
            // #675: current template's logical-id set so recorded entries for a resource
            // removed from the template fold into a nudge (not phantom "removed" drift).
            allLogicalIds: desired.resources.map((r) => r.logicalId),
            // Baseline nudges (removed-entry / stale-baseline) go to STDERR unconditionally
            // — under --json stdout stays pure JSON, but these warnings must NOT vanish
            // entirely (they did under the old `if (!a.json)`). README: all note/warning
            // lines go to stderr; ignore.ts passes console.error unconditionally too. (#871)
            warn: (s: string) => console.error(s),
          },
        }),
        { stackName, accountId: desired.accountId, region },
        config
      );
      if (!a.json) separate();
      const reportHeader = `${posPrefix}${stackName} (${region})`;
      // #755: in --json collect the stack's object (one top-level array printed after the
      // loop); in text mode render inline as before. The interactive flow below is
      // suppressed under --json, so this branch is the whole json output path.
      let code: number;
      if (a.json) {
        const { json, code: jsonCode } = buildStackJson(reconciled, reportHeader);
        jsonReports.push(json);
        code = jsonCode;
      } else {
        code = report(reconciled, reportHeader, {
          verbose: a.verbose,
          // --show-all is inventory mode: list every undeclared value, including the
          // ones at an AWS default (otherwise folded to a count) (R86).
          expandAtDefault: a.showAll,
        });
      }
      const hasUnrecorded = reconciled.some((f) => f.unrecorded === true);

      // R28 (extended R121): drift found in a TTY → offer to resolve it inline
      // (Record / Revert / Ignore / Decide per finding / Nothing) instead
      // of making the user re-run a separate verb. Skipped for --json (machine output),
      // --show-all (baseline not applied — record would mean something else), and
      // --pre-deploy (declared-only, baseline-untouched contract). UNRECORDED values do
      // not set code 1 (R60) but still deserve the prompt. R141: a stack with NO baseline
      // file ALSO opens the prompt even when clean — so the day-1 baseline is established
      // through `check`'s own flow (pick Record) rather than a separate `cdkrd record`.
      // The whole resolution flow lives in interactive-resolve.ts; it returns the exit code.
      if (
        (code === 1 || hasUnrecorded || !baseline) &&
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
          positionPrefix: posPrefix,
        });
      } else if (!baseline && !hasUnrecorded && !a.json && !a.showAll && !a.preDeploy) {
        // R142: no interactive establish prompt could fire (non-TTY, or --fail) and there is
        // no baseline on an otherwise-quiet stack — the report gave no record cue (nothing is
        // unrecorded), so point at how to create the day-1 baseline. stderr keeps stdout clean.
        console.error(
          `note: ${stackName}: no .cdkrd baseline yet — run \`cdkrd record\` to establish one (future out-of-band changes then report as drift).`
        );
      }
      if (code === 1) anyDrift = true;
      worst = Math.max(worst, finalCheckExit(code, a.fail));
      // --strict: incomplete coverage (a skipped resource or an un-recursed nested
      // stack) is a non-zero exit, independent of --fail's drift axis. The loud
      // coverage warnings above always print; --strict makes them CI-failing.
      worst = Math.max(worst, strictCoverageExit(a.strict, gathered.findings, desired.resources));
    } catch (e) {
      if (isStackNotDeployed(e)) {
        // #781: "does not exist" alone cannot tell a NEVER-deployed stack from one DELETED
        // out of band — both surface the same DescribeStacks error. A committed baseline is
        // proof the stack was once deployed, so its presence promotes this from a benign skip
        // (exit 0) to real drift: the deployed state is GONE. Without this, `check --fail`
        // (and `--strict`) exit 0 on a deleted stack, indistinguishable from never-deployed.
        if (hasBaselineForStack(stackName, region)) {
          const msg = 'deployed baseline exists but the stack is gone — deleted out of band';
          const label = `${stackName} (${region})`;
          console.error(`[Drift] ${label}: ${msg}`);
          if (a.json) {
            // A deleted stack is the STRONGEST drift, not a pre-check error: emit
            // drifted:1 + stackDeleted:true (NOT the jsonError shape, which is
            // drifted:0 + `error` reserved for stacks that failed BEFORE being checked).
            // Without this a consumer summing `drifted` sees ZERO on an exit-1 run. (#871)
            jsonReports.push(deletedStackReport(label));
          } else {
            // Text mode: a stdout `result:` line so the documented `^result:` grep catches
            // the deleted stack too (the [Drift] detail above is on stderr like other
            // notes). Without it, `check | grep '^result:'` misses the deleted stack. (#871)
            console.log(
              `${style.resultLabel('result:')} ${style.drift('1 drift(s)')} — ${label}: stack deleted out of band`
            );
          }
          // Drift, not an error: gate on --fail exactly like a per-stack drift code (R53), and
          // make --strict fail regardless (a missing whole stack is the ultimate coverage gap).
          worst = Math.max(worst, finalCheckExit(1, a.fail), a.strict ? 1 : 0);
          anyDrift = true;
          continue;
        }
        console.error(`note: ${stackName}: not deployed yet — skipped`);
        jsonError(stackName, region, 'not deployed yet — skipped');
        continue;
      }
      // a stack that exists but has no meaningful deployed state (REVIEW_IN_PROGRESS /
      // deleting): skip with a clear reason, not a meaningless CLEAN and not an error.
      if (e instanceof StackNotCheckableError) {
        console.error(`note: ${stackName}: ${e.message} — skipped`);
        jsonError(stackName, region, `${e.message} — skipped`);
        // #948: skipping a whole stack (REVIEW_IN_PROGRESS / DELETE_IN_PROGRESS /
        // ROLLBACK_COMPLETE) leaves it entirely unchecked — the maximal coverage gap —
        // so under --strict it must fail (mirroring the deleted-stack fold above and a
        // single skipped RESOURCE already failing --strict). Non-strict stays exit-0.
        worst = Math.max(worst, a.strict ? 1 : 0);
        continue;
      }
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      jsonError(stackName, region, (e as Error).message);
      worst = Math.max(worst, 2);
    }
  }
  // #755: emit the whole invocation's --json output as ONE top-level array (one element
  // per stack — checked, errored, or skipped) so the stream is a single JSON.parse-able
  // value. Printed once here, after the loop, on stdout (the machine channel; all notes /
  // warnings above go to stderr). Even a single-stack run is an array of one, kept uniform
  // so a consumer's JSON.parse always yields an array.
  if (a.json) console.log(JSON.stringify(jsonReports, null, 2));
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

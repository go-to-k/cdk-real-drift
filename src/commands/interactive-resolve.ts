// check's interactive after-report resolution (R28, extended R121). After `check`
// reports drift in a TTY, it offers to resolve it inline instead of making the user
// re-run a separate verb. The top-level choice is:
//   Record all / Revert all / Ignore all  — one action applied to every applicable
//                                            finding (each leads to its own multiselect)
//   Decide per finding                     — assign an action PER finding (the picker)
//   Nothing                                — leave it (default)
// Each bulk option appears only when >=1 finding can take that action; "Decide per
// finding" appears only when >1 finding is decidable (with one, the bulk option already
// IS per-finding). All paths route through the SAME stack-actions code as the standalone
// verbs, so the interactive flow and `cdkrd record/ignore/revert` can never diverge.
import { isCancel, select } from '@clack/prompts';
import {
  applyBaseline,
  type BaselineFile,
  buildRecorded,
  declaredKeysByLogical,
  loadBaseline,
  recordedKey,
} from '../baseline/baseline-file.js';
import { applyIgnores, type CdkrdConfig, loadConfig } from '../config/config-file.js';
import type { Desired } from '../desired/template-adapter.js';
import type { Finding, SchemaInfo } from '../types.js';
import {
  actionPicker,
  applicableActions,
  groupByAction,
  summarizeChoices,
} from './action-picker.js';
import {
  availableActions,
  ignoreStack,
  includeUnrecordedRemovals,
  recordStack,
  resolveInteractiveRevertExit,
  revertStack,
} from './stack-actions.js';

export interface ResolveParams {
  stackName: string;
  region: string;
  desired: Desired;
  findings: Finding[]; // RAW gather findings (pre-baseline) — what the stack-actions expect
  reconciled: Finding[]; // baseline + ignore applied (exactly what the report showed)
  baseline: BaselineFile | undefined;
  schemas: Map<string, SchemaInfo>;
  config: CdkrdConfig;
  code: number; // pre-prompt exit (1 = drift, else 0)
  yes: boolean;
  removeUnrecorded: boolean;
  verbose: boolean;
}

/**
 * Closing note after an interactive record inside `check` (R52). A PARTIAL record used
 * to end with `baseline written: ...` and a silent failure-looking exit. State plainly
 * what remains; check is report-only (exit 0 on drift) unless --fail, and the interactive
 * prompts never fire in fail mode, so this note never coexists with a drift exit. Pure +
 * exported for tests.
 */
export function postRecordNote(remainingUndeclared: number, remainingDeclared: number): string {
  if (remainingDeclared > 0) {
    const alsoUndeclared =
      remainingUndeclared > 0
        ? ` ${remainingUndeclared} unrecorded value(s) also stay reported.`
        : '';
    return `record succeeded, but ${remainingDeclared} declared/deleted drift(s) remain un-addressed (fix the code or choose Revert).${alsoUndeclared}`;
  }
  if (remainingUndeclared > 0)
    return `record succeeded — ${remainingUndeclared} unrecorded value(s) stay reported from the next check on.`;
  return 'stack is now CLEAN.';
}

// Identity shared by raw and reconciled findings (one property of one resource).
const keyOf = (f: Finding): string => `${f.logicalId}::${f.path}`;

// The tier tag shown on each picker row. Anchors the vocabulary to its source so
// "declared" is never misread as the .cdkrd baseline: CFn-declared = in the deployed
// CloudFormation template; undeclared = live-only (not in the template); `unrecorded`
// is the separate baseline-file axis.
const tierTag = (f: Finding): string =>
  f.tier === 'declared'
    ? 'CFn-declared'
    : `undeclared · live-only${f.unrecorded ? ' · unrecorded' : ''}`;

const pickerLabel = (f: Finding): string =>
  `${f.constructPath ?? f.logicalId}${f.path ? `.${f.path}` : ''}  (${tierTag(f)})`;

/**
 * Re-evaluate check's exit WITHOUT re-reading AWS: reload the (possibly just-written)
 * baseline + config and re-apply them to the original gather findings. Declared/deleted
 * drift that the user did not resolve keeps exit 1; ignored findings now drop to the
 * `ignored` tier (config reloaded) and reverted findings are excluded as resolved.
 * Undeclared/unrecorded values never set the exit (R60/R52). TTY-only, so no CI contract.
 */
async function recomputeExit(p: ResolveParams, resolvedKeys: Set<string>): Promise<number> {
  const nb = await loadBaseline(p.stackName, p.desired.accountId, p.region);
  const nc = await loadConfig();
  const reEval = applyIgnores(
    applyBaseline(p.findings, nb, {
      declaredByLogical: declaredKeysByLogical(p.desired.resources),
    }),
    p.stackName,
    nc
  );
  const remainingDeclared = reEval.filter(
    (f) => (f.tier === 'declared' || f.tier === 'deleted') && !resolvedKeys.has(keyOf(f))
  ).length;
  return remainingDeclared > 0 ? 1 : 0;
}

export async function resolveInteractively(p: ResolveParams): Promise<number> {
  // Whether undeclared REMOVE ops belong in a revert plan — true in a gated TTY prompt.
  const includeRemovals = includeUnrecordedRemovals(p.removeUnrecorded, true, p.yes);
  const actions = availableActions(p.reconciled, p.baseline, p.schemas, includeRemovals);
  if (!actions.record && !actions.ignore && !actions.revert) return p.code;

  const options: { value: string; label: string }[] = [];
  if (actions.record)
    options.push({
      value: 'record-all',
      label:
        'Record all undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)',
    });
  if (actions.revert)
    options.push({ value: 'revert-all', label: 'Revert all — write the desired values to AWS' });
  if (actions.ignore)
    options.push({
      value: 'ignore-all',
      label: 'Ignore all — stop reporting it (writes .cdkrd/config.json)',
    });
  const decidable = p.reconciled.filter((f) => applicableActions(f).length > 0);
  if (decidable.length > 1)
    options.push({ value: 'per-finding', label: 'Decide per finding — pick an action for each' });
  options.push({ value: 'nothing', label: 'Nothing (decide later)' });

  const choice = await select({
    message:
      p.code === 1
        ? `${p.stackName}: drift found — what do you want to do?`
        : `${p.stackName}: unrecorded values found — what do you want to do?`,
    options,
    initialValue: 'nothing',
  });
  if (isCancel(choice) || choice === 'nothing') return p.code;

  if (choice === 'record-all') return recordAll(p);
  if (choice === 'ignore-all') return ignoreAll(p);
  if (choice === 'revert-all') return revertAll(p);
  if (choice === 'per-finding') return perFinding(p, decidable);
  return p.code;
}

// record records UNDECLARED only; recordStack emits the "declared/deleted NOT approved"
// scope note after the write (R117), so this path warns consistently with `cdkrd record`.
async function recordAll(p: ResolveParams): Promise<number> {
  const result = await recordStack({
    stackName: p.stackName,
    region: p.region,
    desired: p.desired,
    findings: applyIgnores(p.findings, p.stackName, p.config),
    yes: p.yes,
    interactive: true,
  });
  if (!result.wrote) return p.code;
  // R52: a successful interactive record is a SUCCESS for THIS run — unselected
  // undeclared values surface from the next check on, not as a failure now. Declared/
  // deleted drift is outside record's reach and keeps exit 1. Say what remains plainly.
  const nb = await loadBaseline(p.stackName, p.desired.accountId, p.region);
  const reEval = applyIgnores(
    applyBaseline(p.findings, nb, {
      declaredByLogical: declaredKeysByLogical(p.desired.resources),
    }),
    p.stackName,
    p.config
  );
  const remainingDeclared = reEval.filter(
    (f) => f.tier === 'declared' || f.tier === 'deleted'
  ).length;
  const remainingUndeclared = reEval.filter((f) => f.tier === 'undeclared').length;
  console.error(`note: ${p.stackName}: ${postRecordNote(remainingUndeclared, remainingDeclared)}`);
  return remainingDeclared > 0 ? 1 : 0;
}

async function ignoreAll(p: ResolveParams): Promise<number> {
  // reconciled = the report's declared + undeclared findings; ignoreStack shows its own
  // multiselect (default all) when !yes, mirroring `cdkrd ignore`.
  const result = await ignoreStack({
    stackName: p.stackName,
    findings: p.reconciled,
    yes: p.yes,
    interactive: true,
  });
  return result.wrote ? recomputeExit(p, new Set()) : p.code;
}

async function revertAll(p: ResolveParams): Promise<number> {
  const outcome = await revertStack({
    stackName: p.stackName,
    region: p.region,
    gathered: { desired: p.desired, findings: p.findings, schemas: p.schemas },
    baseline: p.baseline,
    config: p.config,
    dryRun: false,
    yes: p.yes,
    removeUnrecorded: p.removeUnrecorded,
    verbose: p.verbose,
    interactive: true,
  });
  // R30: an aborted confirm wrote nothing, so the drift still stands — keep exit 1.
  return resolveInteractiveRevertExit(p.code, outcome);
}

async function perFinding(p: ResolveParams, decidable: Finding[]): Promise<number> {
  const rows = decidable.map((f) => ({ label: pickerLabel(f), applicable: applicableActions(f) }));
  const chosen = await actionPicker(`${p.stackName}: assign an action to each finding`, rows);
  if (chosen === undefined) return p.code; // cancelled — nothing applied
  const groups = groupByAction(decidable, chosen);
  if (groups.record.length + groups.ignore.length + groups.revert.length === 0) return p.code;

  // record: the picker already chose which undeclared values — recordStack records
  // exactly those (preselectedKeys) while still auto-keeping the existing baseline.
  if (groups.record.length > 0) {
    const preselectedKeys = new Set(buildRecorded(groups.record).map(recordedKey));
    await recordStack({
      stackName: p.stackName,
      region: p.region,
      desired: p.desired,
      findings: applyIgnores(p.findings, p.stackName, p.config),
      yes: p.yes,
      interactive: true,
      preselectedKeys,
    });
  }
  // ignore: write rules for exactly the chosen findings (yes:true skips ignoreStack's
  // own multiselect — the picker IS the selection). addIgnoreRules unions, no data loss.
  if (groups.ignore.length > 0) {
    await ignoreStack({
      stackName: p.stackName,
      findings: groups.ignore,
      yes: true,
      interactive: true,
    });
  }
  // revert (AWS, last): pass ONLY the chosen findings; autoSelectAll skips the op
  // multiselect (already chosen) but keeps the AWS-write confirm.
  let revertResolved = new Set<string>();
  let revertExit = 0;
  if (groups.revert.length > 0) {
    const revertKeys = new Set(groups.revert.map(keyOf));
    const outcome = await revertStack({
      stackName: p.stackName,
      region: p.region,
      gathered: {
        desired: p.desired,
        findings: p.findings.filter((f) => revertKeys.has(keyOf(f))),
        schemas: p.schemas,
      },
      baseline: p.baseline,
      config: p.config,
      dryRun: false,
      yes: p.yes,
      removeUnrecorded: p.removeUnrecorded,
      verbose: p.verbose,
      interactive: true,
      autoSelectAll: true,
    });
    if (!outcome.aborted) {
      revertResolved = revertKeys; // converged-or-attempted; outcome.exit folds in non-convergence
      revertExit = outcome.exit;
    }
  }
  console.error(
    `note: ${p.stackName}: per-finding decisions applied (${summarizeChoices(chosen)}).`
  );
  return Math.max(await recomputeExit(p, revertResolved), revertExit);
}

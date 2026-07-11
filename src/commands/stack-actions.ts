// Per-stack record / revert actions, shared by the standalone `record` / `revert`
// commands AND `check`'s interactive after-drift prompt (R28). Extracting them keeps
// the interactive flow and the single-verb commands behaviourally identical: both go
// through exactly the same record / plan / apply / converge code.
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { confirm, isCancel } from '@clack/prompts';
import {
  recordedKey,
  applyBaseline,
  type BaselineFile,
  baselineOnlyEntries,
  buildRecorded,
  carryForwardIgnored,
  carryForwardUnreadable,
  checkBaselineAccount,
  constructPathsByLogical,
  declaredKeysByLogical,
  loadBaseline,
  physicalIdsByLogical,
  type RecordedEntry,
  recordedValueForChanged,
  selectRecorded,
  splitRecordedByBaseline,
  writeBaseline,
} from '../baseline/baseline-file.js';
import {
  addIgnoreRules,
  applyIgnores,
  type CdkrdConfig,
  ignoreRuleFor,
} from '../config/config-file.js';
import { withinStackPath } from '../construct-path.js';
import { sanitizeForTerminal } from '../report/report.js';
import { redactValue } from '../report/redact.js';
import { style } from '../report/style.js';
import { bulkMultiselect } from './bulk-multiselect.js';
import { CLIENT_TIMEOUTS } from '../read/client-config.js';
import { CC_IDENTIFIER_ADAPTERS } from '../read/router.js';
import {
  applyRevertDelete,
  applyRevertDeletes,
  applyRevertDeleteSdk,
  applyRevertItem,
} from '../revert/apply.js';
import {
  buildRevertPlan,
  isContractOp,
  maskReadGapKeysOf,
  rejectedEmptyStripOps,
  type RevertItem,
  type RevertPlan,
  tagPreservingOps,
  writeOnlyReincludeOps,
} from '../revert/plan.js';
import { errorText, type RetryOptions, retryTransient } from '../revert/transient.js';
import { resolveSdkWriter, SDK_DELETERS } from '../revert/writers.js';
import { deepEqual } from '../diff/drift-calculator.js';
import type { Finding, SchemaInfo } from '../types.js';
import { type Desired } from '../desired/template-adapter.js';
import { buildSiblingSgRules, type GatherResult, regatherTouched } from './gather.js';

// unrecorded values (R62) are awaiting a decision, not drift — they never count
// toward "drift(s) remain" messaging or the convergence check.
const isDrift = (f: Finding): boolean =>
  (f.tier === 'deleted' ||
    f.tier === 'added' ||
    f.tier === 'declared' ||
    f.tier === 'undeclared') &&
  !f.unrecorded;
const driftCount = (findings: Finding[]): number => findings.filter(isDrift).length;
const unrecordedCount = (findings: Finding[]): number =>
  findings.filter((f) => f.unrecorded === true).length;

// #756: identity of a single reconciled finding, used to restrict a per-finding revert's
// plan to exactly the findings the user picked. MUST match interactive-resolve.ts's
// exported keyOf (same logicalId + path + attributeKey shape) — that is the format the
// caller passes in `selectedFindingKeys`.
const findingKeyOf = (f: Finding): string =>
  `${f.logicalId}::${f.path}${f.attributeKey !== undefined ? `[${f.attributeKey}]` : ''}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The per-stack label shown in a DECISION prompt — the SAME `Name (region)` form the
 * report header uses (`check.ts` `${stackName} (${region})`). After #899 exact-name
 * selection targets EVERY same-named region instance, so a bare `stackName` in a
 * record/ignore/revert prompt is indistinguishable across regions (a wrong-region
 * record/ignore/revert hazard, #947). Naming the region disambiguates them. Pure +
 * exported so the wording is unit-tested.
 */
export function stackLabel(stackName: string, region: string): string {
  return `${stackName} (${region})`;
}

/**
 * Print the stack-state warning (#786) — a stack that is mid-operation (`*_IN_PROGRESS`)
 * or in a failed state (`*_FAILED`) carries a `stackStatusWarning` from `loadDesired`
 * (via `classifyStackStatus`). `check` prints it (`check.ts`), but the standalone
 * `record` / `ignore` / `revert` verbs never consumed it — so a `record` mid-`cdk deploy`
 * would snapshot transient values into the git baseline, and a `revert` would fight the
 * in-flight deploy, all silently. This centralizes the SAME wording/stderr routing check
 * uses so every verb surfaces the warning identically. No-op when the stack is stable.
 */
export function warnStackStatus(stackName: string, warning: string | undefined): void {
  if (warning) console.error(`warning: ${stackName}: ${warning}`);
}

/**
 * TOCTOU guard (#786): re-read the stack's live `StackStatus` immediately before a
 * revert's Cloud Control / SDK write and REFUSE when it is mid-operation
 * (`*_IN_PROGRESS`). A stack stable at gather time can enter a `cdk deploy` while the
 * revert confirm prompt sits open — writing OLD values onto an updating stack fights the
 * deploy. `revert` is the one AWS-mutating verb, so the gate must be right before the
 * write, not only at gather time. Returns a refusal reason string when the write must be
 * refused, or `undefined` when it is safe to proceed. A DescribeStacks read error is NOT
 * treated as a refusal (fail-open: the gather already succeeded, so a transient re-read
 * failure should not block a legitimate revert) — only a confirmed in-progress state does.
 */
export async function stackInProgressRefusal(
  stackName: string,
  region: string
): Promise<string | undefined> {
  let status: string | undefined;
  try {
    const cfn = new CloudFormationClient({ region, ...CLIENT_TIMEOUTS });
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    status = res.Stacks?.[0]?.StackStatus;
  } catch {
    // Fail-open: the gather already read this stack successfully, so a transient
    // re-read failure must not block a legitimate revert. Only a CONFIRMED in-progress
    // state refuses.
    return undefined;
  }
  if (status?.endsWith('_IN_PROGRESS')) {
    return `refusing to write to AWS — ${stackName} is mid-operation (${status}). A revert now would fight the in-flight deploy/update. Wait for the stack to settle, then re-run.`;
  }
  return undefined;
}

/**
 * The revert confirm message (R52). When NOT-revertable findings exist (e.g. a
 * no-baseline first check with one declared drift and 100+ undeclared values),
 * users read "This WRITES to AWS" as "everything I just saw gets written" —
 * state explicitly that ONLY the listed op(s) are written and the rest is
 * untouched. Pure + exported so the wording is unit-tested.
 */
export function revertConfirmMessage(
  stackName: string,
  region: string,
  opCount: number,
  notRevertableCount: number,
  deleteCount = 0
): string {
  const scope =
    notRevertableCount > 0
      ? ` Only the ${opCount} selected op(s) are written — the ${notRevertableCount} NOT-revertable finding(s) are untouched.`
      : '';
  // #764: a `delete`-kind op DELETES a whole out-of-band resource (not a property
  // patch), so the confirm must name how many resources will be DELETED — otherwise a
  // user reading "revert op(s)" under --yes has no signal that a resource is destroyed.
  const del =
    deleteCount > 0 ? ` ${deleteCount} of these DELETE(S) a whole out-of-band resource.` : '';
  return `Apply ${opCount} revert op(s) to ${stackLabel(stackName, region)}? This WRITES to AWS.${del}${scope}`;
}

/**
 * The post-revert surviving-drift pointer list (R46), capped (R52): after a
 * partial revert on a no-baseline stack, every unrecorded undeclared value
 * "survives" — re-listing 100+ lines the user just saw in the report is noise.
 * Show up to `cap` entries, then a one-line fold. Pure + exported for tests.
 */
export function formatSurvivingDrift(remaining: Finding[], stackName = '', cap = 10): string[] {
  const idOf = (f: Finding): string =>
    f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId;
  const lines = remaining
    .slice(0, cap)
    .map((f) => `  - ${idOf(f)}${f.path ? `.${f.path}` : ''} (${f.tier})`);
  if (remaining.length > cap)
    lines.push(`  ... and ${remaining.length - cap} more — run \`cdkrd check\` for the full list`);
  return lines;
}

/**
 * Header for record's multiselect (R49, R116). The key hints (space / → / ← / enter)
 * are rendered by `bulkMultiselect` itself, so this is just the one-line prompt. When
 * `foldedCount` > 0 it DISCLOSES that those nested sub-keys are recorded too — the picker
 * lists only the standout rows, so without this the user could see (say) one row and not
 * realise enter also records the folded values. The folded values are NOT individually
 * deselectable here: "record only the standout, keep the folded reported" has no use case
 * (the folded would just nag forever), whereas deselecting a standout to "record the rest"
 * IS useful — so standouts toggle, the folded always record. Pure + exported.
 */
export function recordSelectMessage(stackName: string, region: string, foldedCount = 0): string {
  const fold =
    foldedCount > 0
      ? `; +${foldedCount} folded sub-key(s) ALWAYS recorded too (--verbose to itemize)`
      : '';
  return `${stackLabel(stackName, region)}: select undeclared value(s) to record (unselected stay reported)${fold}`;
}

/**
 * #790: header for the record DROP multiselect — the baseline-only entries (a recorded value
 * reverted to its AWS default, or removed out of band). Selecting a row DROPS the recorded
 * watch (accept the drift); leaving it UNSELECTED preserves the entry (it keeps reporting as
 * drift). Default-unselected, so one Enter here changes nothing. Pure + exported for unit tests.
 */
export function recordDropMessage(stackName: string, region: string): string {
  return `${stackLabel(stackName, region)}: recorded value(s) reverted-to-default / removed since record — select to DROP from the baseline (unselected stay watched & reported)`;
}

/**
 * #758: a compact single-line preview of a recorded/live VALUE for a record-picker label —
 * so a `changed since record` row can show `recorded → live` and the user can see WHAT they
 * are blessing (instead of a bare `Res.Path`). JSON-encoded (scalars stay bare-ish), then
 * truncated to keep the multiselect row on one line. Pure + exported for unit tests.
 *
 * #1302: this row prints straight to an interactive terminal (the clack multiselect), so it
 * needs the two hardening layers the report path applies to displayed VALUES:
 *   (a) REDACTION — a secret-bearing path (Lambda/CodeBuild env var, the #798/#1234 masked
 *       set) must not print its recorded/rotated plaintext into the terminal; mask it via the
 *       same `redactValue(resourceType, path, v)` the text + --json renderers use, BEFORE
 *       truncation.
 *   (b) TERMINAL SANITIZING — a live string is charset-permissive and could carry `\r` / ESC
 *       sequences (the #829 injection class); report.ts values are C0-safe only because they
 *       route through `JSON.stringify`. Here a string was returned verbatim, so route EVERY
 *       displayed form (string AND JSON-encoded) through `sanitizeForTerminal`.
 * DISPLAY-ONLY — the recorded value itself is unchanged; only what the picker prints is masked
 * and sanitized.
 */
export function previewValue(resourceType: string, path: string, v: unknown, max = 40): string {
  const masked = redactValue(resourceType, path, v);
  let s: string;
  try {
    s = typeof masked === 'string' ? masked : JSON.stringify(masked);
  } catch {
    s = String(masked);
  }
  if (s === undefined) s = String(masked); // JSON.stringify(undefined) === undefined
  s = sanitizeForTerminal(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * #758: the record multiselect label for a `changed` entry — a path already in the baseline
 * whose live value differs this run (a recorded value CHANGED out of band). Distinct from a
 * plain new-path row: it shows `recorded → live` (or a `(changed since record)` marker when the
 * old value could not be paired) so the user does not silently bless a possibly-attacker-changed
 * value under a bare label. Pure + exported for unit tests.
 */
export function changedRecordLabel(
  entry: { logicalId: string; path: string; value: unknown; resourceType: string },
  recordedValue: { hasRecorded: boolean; recordedValue: unknown }
): string {
  const id = entry.path
    ? `${entry.logicalId}.${entry.path}`
    : `${entry.logicalId} (added resource)`;
  if (!recordedValue.hasRecorded) return id; // genuinely NEW path — plain row
  // #1302: thread the finding's resourceType + path so the preview can redact a secret-bearing
  // path and sanitize control chars — both the recorded and live sides.
  const recorded = previewValue(entry.resourceType, entry.path, recordedValue.recordedValue);
  const live = previewValue(entry.resourceType, entry.path, entry.value);
  return `${id} (changed since record: ${recorded} → ${live})`;
}

/**
 * #790: the record multiselect label for a `baseline-only` drop-candidate — a recorded value
 * that reverted to its AWS default (now folded away) or was REMOVED out of band, so it has no
 * current undeclared finding. Selecting the row DROPS the recorded watch (an accept-drift
 * action, so the row is default UNSELECTED); leaving it keeps the entry in the baseline. Pure +
 * exported for unit tests.
 */
export function dropRecordLabel(entry: { logicalId: string; path: string }): string {
  const id = entry.path
    ? `${entry.logicalId}.${entry.path}`
    : `${entry.logicalId} (added resource)`;
  return `${id} (reverted-to-default / removed since record — drop from baseline?)`;
}

/**
 * Split the to-record delta into STANDOUT (itemized in the record multiselect) and FOLDED
 * (nested live-only sub-keys — the `undeclared-subkey` mass the report folds, R96). Folded
 * entries are auto-recorded as a summarized count instead of dozens of rows. `expandNested`
 * (--verbose) turns the fold off so every nested value is itemized. An entry is folded when
 * its matching gather finding is a `nested` undeclared value — EXCEPT a free-form map key
 * (freeFormKey), which the report shows in full, so the picker itemizes it too. Pure + exported.
 */
export function splitFoldedNested<T extends { logicalId: string; path: string }>(
  changed: T[],
  findings: Finding[],
  expandNested: boolean | undefined
): { standout: T[]; folded: T[] } {
  if (expandNested) return { standout: changed, folded: [] };
  const nestedKeys = new Set(
    findings
      .filter((f) => f.nested === true && f.tier === 'undeclared' && !f.freeFormKey)
      .map((f) => `${f.logicalId}::${f.path}`)
  );
  const isFolded = (e: T): boolean => nestedKeys.has(`${e.logicalId}::${e.path}`);
  return { standout: changed.filter((e) => !isFolded(e)), folded: changed.filter(isFolded) };
}

/**
 * Post-record scope note (or undefined). `record` snapshots UNDECLARED state and (PR4)
 * out-of-band `added` resources into the baseline — but it CANNOT silence DECLARED or
 * DELETED drift, which is divergence from your template intent a baseline does not
 * govern (`buildRecorded` keeps only undeclared + added). Users read "record" as
 * "approve EVERYTHING I just saw", so when declared/deleted drift is present say plainly
 * that it was NOT approved and still stands. Resolution: revert it, `cdkrd ignore` it
 * (declared — stop reporting), or `cdk deploy`. Pure + exported (emitted by both `cdkrd
 * record` and check's interactive record, so the scope is stated wherever record runs —
 * previously only check's path warned). R117.
 */
export function recordScopeNote(stackName: string, findings: Finding[]): string | undefined {
  const n = findings.filter((f) => f.tier === 'declared' || f.tier === 'deleted').length;
  if (n === 0) return undefined;
  return `note: ${stackName}: record snapshotted undeclared + added state into the baseline only — ${n} declared/deleted drift NOT approved (it still reports as drift; resolve with cdkrd revert, cdkrd ignore, or cdk deploy).`;
}

/**
 * The success line after a record writes the baseline. Three outcomes (R142):
 *  - refreshed: nothing new to decide, the already-recorded unchanged set was re-snapshotted;
 *  - initialized: the FIRST baseline on a CLEAN stack (no prior file, zero recorded entries)
 *    — a day-1 INITIALIZATION, not a no-op, so it states what it established (the stack is now
 *    tracked → a later out-of-band undeclared value reports as drift) rather than the cold
 *    "(0 recorded entry(ies))" that read as "nothing happened";
 *  - written: the normal case, N recorded entries.
 * Pure + exported so the wording is unit-tested. `count` is undeclared values + (PR4)
 * out-of-band added resources — "recorded entry(ies)" covers both.
 */
export function recordOutcomeMessage(
  stackName: string,
  path: string,
  count: number,
  refreshedOnly: boolean,
  hadPriorBaseline: boolean
): string {
  if (refreshedOnly)
    return `${stackName}: nothing new to record — baseline refreshed (${count} unchanged value(s))`;
  if (!hadPriorBaseline && count === 0)
    return `${stackName}: baseline initialized — ${path} (no undeclared values to record; this stack is now tracked — future out-of-band changes report as drift)`;
  return `baseline written: ${path} (${count} recorded entry(ies))`;
}

/**
 * Build the interactive revert multiselect options from a plan (R57). Revert is
 * now symmetric with record: choosing Revert lets you pick WHICH op(s) to write
 * — "select the things to revert" is the user's natural reading of the flow.
 * EVERY op starts UNSELECTED (R137): revert is the one AWS-mutating verb, so nothing
 * is pre-armed — the user opts in to each write explicitly (→ selects all at once).
 * Pre-selecting RESTORE ops but not REMOVE ops was a confusing asymmetry: a console
 * change to a declared property would be silently primed for write-back while an
 * undeclared one was not. REMOVE ops still carry a (REMOVE) label so a destructive
 * delete is visible. Pure + exported.
 */
export function revertSelectOptions(
  plan: RevertPlan
): { value: string; label: string; selected: boolean }[] {
  const options: { value: string; label: string; selected: boolean }[] = [];
  for (const item of plan.items) {
    for (const op of item.ops) {
      // #967: a CONTRACT op (null-husk strip) is plumbing coupled to a real op, not a
      // user-chosen write — never offer it as its own selectable row. filterRevertPlan
      // always carries it through for any item that keeps ≥1 real op, and drops the
      // whole item (contract op included) when the user selected none of its real ops,
      // so a bucket can never be written a contract-only patch.
      if (isContractOp(op)) continue;
      // `delete` items delete a whole out-of-band resource — the loudest destructive
      // action, marked (DELETE); a property REMOVE keeps its (REMOVE) marker.
      const marker = item.kind === 'delete' ? ' (DELETE)' : op.op === 'remove' ? ' (REMOVE)' : '';
      options.push({
        value: revertOpKey(item, op),
        label: `${item.displayId}: ${op.human}${marker}`,
        selected: false,
      });
    }
  }
  return options;
}

function revertOpKey(item: RevertItem, op: RevertItem['ops'][number]): string {
  // Include attributeKey: ELB attribute-bag ops all share one op.path
  // (/LoadBalancerAttributes) and differ only by attributeKey, so without it every
  // bag attribute collapses to one multiselect row and toggles as a unit. Non-bag
  // ops have no attributeKey, so their key is unchanged.
  const attr = op.attributeKey !== undefined ? `${op.attributeKey}` : '';
  return `${item.logicalId}${item.kind}${op.path}${attr}`;
}

/**
 * Keep only the selected ops; items left with no REAL op drop out. Pure + exported.
 *
 * #967: a CONTRACT op (null-husk strip) is never a selectable row, so it is never in
 * `picked` — but it is coupled to its item's real revert ops (without the strip, the CC
 * patch hard-fails model validation, #641). So it is NOT filtered by the pick set: it
 * ALWAYS rides along an item that retains ≥1 real (non-contract) selected op, and is
 * DROPPED with the whole item when the user selected none of that item's real ops.
 * This keeps both invariants: a real revert op can never be sent without its coupled
 * husk strip, and a husk strip can never be sent alone as a user-chosen write.
 */
export function filterRevertPlan(plan: RevertPlan, picked: Set<string>): RevertPlan {
  const items = plan.items
    .map((item) => {
      const realSelected = item.ops.filter(
        (op) => !isContractOp(op) && picked.has(revertOpKey(item, op))
      );
      // No real op survived the pick → drop the whole item (contract ops included), so a
      // bucket the user chose nothing for is never written a contract-only patch.
      if (realSelected.length === 0) return { ...item, ops: [] };
      // At least one real op is kept → carry EVERY contract op through with it.
      const contract = item.ops.filter(isContractOp);
      return { ...item, ops: [...contract, ...realSelected] };
    })
    .filter((item) => item.ops.length > 0);
  return { items, notRevertable: plan.notRevertable };
}

export function revertSelectMessage(stackName: string, region: string): string {
  return `${stackLabel(stackName, region)}: select the op(s) to revert (unselected are not written)`;
}

/**
 * #967: the op count SHOWN to the user (confirm prompt + --dry-run preview) counts only
 * REAL revert ops — a CONTRACT op (null-husk strip) is plumbing coupled to a real op,
 * not a distinct write the user chose, so counting it would inflate the number the user
 * consents to. The full augmented patch (contract ops included) is still what is SENT to
 * AWS; this is purely the user-facing intent count. Pure + exported for unit tests.
 */
export function realOpCount(plan: RevertPlan): number {
  return plan.items.reduce((n, i) => n + i.ops.filter((op) => !isContractOp(op)).length, 0);
}

// ---- record ----

export interface RecordStackParams {
  stackName: string;
  region: string;
  desired: Desired;
  findings: Finding[]; // the gather's findings (undeclared still present, pre-baseline)
  yes: boolean;
  interactive: boolean; // whether the multiselect decision prompt may be shown (TTY only)
  // check's "Decide per finding" path (R121): the user already chose WHICH undeclared
  // values to record in the action picker, so recordStack skips its own multiselect and
  // records exactly these (keyed by recordedKey). Already-recorded unchanged values are
  // still auto-kept, so this never drops the rest of the baseline.
  preselectedKeys?: Set<string>;
  // Mirror the report's R96 fold: by default the record multiselect itemizes only the
  // STANDOUT (non-nested) undeclared values and auto-records the nested live-only sub-keys
  // (the `undeclared-subkey` mass the report folds) as a summarized count, instead of
  // listing dozens of nested rows. `--verbose` sets this true to itemize every nested
  // value individually (mirrors the report's --verbose fold-expansion; --show-all is the
  // separate inventory mode and suppresses the interactive prompt, so it never reaches here).
  expandNested?: boolean;
  // #868: under `record --json` the human success line is suppressed (the caller emits a
  // machine JSON element instead); notes/warnings still go to stderr. Defaults to text mode,
  // so check's interactive path is unaffected.
  json?: boolean;
}

/**
 * Outcome of a per-stack record.
 *  - `wrote`: a baseline file was written.
 *  - `refused`: true ONLY when a decision was required (undeclared values to record)
 *    but the run is non-interactive and `--yes` was not passed — record refuses
 *    rather than recording everything by default (R38). A user-cancelled multiselect
 *    is `{ wrote:false, refused:false }`, not a refusal.
 */
export interface RecordResult {
  wrote: boolean;
  refused: boolean;
  count?: number; // #868: how many undeclared value(s) were recorded (for --json)
  path?: string; // #868: the baseline file written (for --json)
}

/**
 * Record the current undeclared state into the baseline file. In an interactive run
 * (no --yes) the user picks WHICH undeclared values to record (selective record, R14).
 * When an existing baseline is present the multiselect shows only the DELTA from it
 * (new/changed); already-recorded unchanged values are auto-kept and surfaced with a
 * note (R39). An empty FINAL set is confirmed first (R19). Non-interactively
 * (non-TTY: CI/cron/pipes), the multiselect is a required DECISION: with
 * undeclared values present and no --yes, record refuses (exit 2) instead of recording
 * all (R38). When there is nothing to decide (no undeclared values) the baseline is
 * written regardless. (Same flow whether reached via `cdkrd record` or check's
 * interactive prompt — neither re-gathers.)
 */
export async function recordStack(p: RecordStackParams): Promise<RecordResult> {
  const { stackName, region, desired, findings, yes, interactive, preselectedKeys, expandNested } =
    p;
  const existing = await loadBaseline(stackName, desired.accountId, region);
  // Identity guard BEFORE consuming `existing`: record reads the prior baseline
  // (carryForwardUnreadable, completeResources monotonicity, prior physical-id fallback)
  // and then `writeBaseline` re-stamps the CURRENT accountId — so without this a baseline
  // captured in another account would be silently consumed and re-stamped, laundering the
  // mismatch. `loadBaseline` already guards the stack/region axes; this covers the account
  // axis, matching the check/ignore/revert callers (throws → caller surfaces exit 2).
  if (existing) checkBaselineAccount(existing, desired.accountId, stackName);
  if (!yes && existing)
    console.error(
      `note: ${stackLabel(stackName, region)}: will overwrite the existing baseline file on confirm (nothing written yet; it is git-tracked — review the diff afterwards). Pass --yes to silence.`
    );
  // Seed with this run's observed entries, then carry forward any prior baseline
  // entries for resources this run could NOT read (skipped / model-read-failed) so a
  // re-record never silently shrinks the committed baseline (writeBaseline full-replaces).
  // #1078: also carry forward any prior entry for a path CURRENTLY suppressed by an
  // ignore rule (tier `ignored` this run — the findings are `applyIgnores`'d before
  // reaching record). buildRecorded drops ignored findings, so without this the endorsed
  // entry would be full-replaced away, and deleting the rule later would false-surface the
  // untouched value as confirmed "appeared since record" drift. The carried entry is inert
  // while the rule lives (ignore wins in applyBaseline); it lets watching resume against a
  // real snapshot once the rule is deleted. Pairs with computeCompleteResources's #1078
  // demotion for the never-recorded variant (no prior entry to carry).
  let recorded = carryForwardIgnored(
    carryForwardUnreadable(buildRecorded(findings), existing, findings),
    existing,
    findings
  );
  // #790: baseline entries with NO current undeclared finding for a resource read cleanly —
  // a recorded value reverted to its AWS default (folded away) or removed out of band. A naive
  // full-replace re-record would silently DROP these (accepting drift `check` force-surfaces).
  // Compute them up front so they can be PRESERVED by default under every path (--yes and
  // interactive), and surfaced as an explicit "drop?" row in the interactive picker.
  const dropCandidates: RecordedEntry[] = baselineOnlyEntries(recorded, existing, findings, {
    declaredByLogical: declaredKeysByLogical(desired.resources),
    allLogicalIds: desired.resources.map((r) => r.logicalId),
  });
  // #790: the baseline-only entries the user chose to DROP (interactive picker only). Empty by
  // default so an entry is always PRESERVED unless explicitly selected — a re-record must not
  // silently accept a reverted-to-default / removed value that `check` force-surfaces as drift.
  const droppedKeys = new Set<string>();
  // #758: a `record --yes` (scripts/CI) accepts every current value with no prompt. Echo a
  // summary of what it BLESSED — recorded values CHANGED out of band (a possibly attacker-
  // changed value) and baseline-only entries PRESERVED — so the acceptance is not silent.
  if (yes && existing) {
    const { changed } = splitRecordedByBaseline(recorded, existing);
    const changedExisting = changed.filter((e) => recordedValueForChanged(e, existing).hasRecorded);
    if (changedExisting.length > 0)
      console.error(
        `note: ${stackName}: --yes accepted ${changedExisting.length} recorded value(s) CHANGED out of band since record (review the baseline diff): ` +
          changedExisting.map((e) => `${e.logicalId}.${e.path}`).join(', ')
      );
    if (dropCandidates.length > 0)
      console.error(
        `note: ${stackName}: --yes PRESERVED ${dropCandidates.length} recorded watch(es) whose value reverted-to-default / was removed since record (they still report as drift; re-run interactively to drop them)`
      );
  }
  let refreshedOnly = false; // true when only unchanged values remained (no delta to decide)
  // #790: a decision is also required when there are baseline-only drop candidates but zero
  // current undeclared values (the exact reverted-to-default case) — else the interactive
  // block is skipped and the drop rows are never shown.
  if (!yes && (recorded.length > 0 || dropCandidates.length > 0)) {
    // A decision is required (which undeclared values to record). Non-interactively
    // we refuse rather than implicitly record ALL of them (R38).
    if (!interactive) {
      console.error(
        `error: record needs a decision — pass --yes to record ALL undeclared values, or run interactively`
      );
      return { wrote: false, refused: true };
    }
    // Only make the human decide on the DELTA from the existing baseline: already-recorded
    // unchanged values are auto-kept (re-confirming a 50-item snapshot every time is wrong,
    // R39). With no baseline the split returns everything as `changed` (the true first record).
    const { unchanged, changed } = splitRecordedByBaseline(recorded, existing);
    if (unchanged.length > 0)
      console.error(
        `note: ${stackName}: keeping ${unchanged.length} already-recorded unchanged value(s)`
      );
    if (changed.length === 0) {
      // Nothing new to decide — just refresh the baseline (re-snapshot the unchanged set).
      // #790: dropCandidates still get their own picker below, so this is a refresh only when
      // there is also nothing to drop.
      recorded = unchanged;
      refreshedOnly = dropCandidates.length === 0;
    } else {
      // Per-finding path: the action picker already chose the keys, so take them
      // directly (no second prompt). Otherwise show the record multiselect.
      let picked: string[];
      if (preselectedKeys) {
        picked = changed.map((e) => recordedKey(e)).filter((k) => preselectedKeys.has(k));
      } else {
        // Mirror the report's R96 fold: itemize only the STANDOUT (non-nested) values; the
        // folded nested sub-keys (the `undeclared-subkey` mass) are ALWAYS recorded and the
        // header discloses the count. They are deliberately NOT individually deselectable —
        // "record only the standout, keep the folded reported" has no use case (the folded
        // would just nag forever), while deselecting a standout to "record the rest" stays
        // possible (the folded still record). To record nothing, cancel (esc). `--verbose`
        // (expandNested) itemizes every nested value as its own row instead (`--show-all` is
        // the separate inventory mode — it suppresses this prompt, so it can't itemize here).
        const { standout, folded } = splitFoldedNested(changed, findings, expandNested);
        if (standout.length === 0) {
          // Nothing to itemize (every changed value is a folded nested sub-key — the common
          // all-nested first run). A Yes/No commit replaces the empty multiselect.
          const proceed = await confirm({
            message: `${stackLabel(stackName, region)}: record ${folded.length} undeclared sub-key value(s)? (--verbose to itemize each)`,
            initialValue: true,
          });
          if (isCancel(proceed) || !proceed) {
            console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
            return { wrote: false, refused: false };
          }
          picked = changed.map((e) => recordedKey(e));
        } else {
          const fromPrompt = await bulkMultiselect(
            recordSelectMessage(stackName, region, folded.length),
            standout.map((e) => {
              // #758: a `changed` standout that has a MATCHING baseline entry is a recorded
              // value CHANGED out of band — show `recorded → live` and default it UNSELECTED
              // so the (possibly attacker-changed) value is not blessed by one Enter. A
              // genuinely NEW path stays default-selected (today's behavior).
              const rec = recordedValueForChanged(e, existing);
              return {
                value: recordedKey(e),
                label: changedRecordLabel(e, rec),
                selected: !rec.hasRecorded,
              };
            })
          );
          if (fromPrompt === undefined) {
            console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
            return { wrote: false, refused: false };
          }
          // the folded nested values are always recorded alongside the picked standouts
          picked = [...fromPrompt, ...folded.map((e) => recordedKey(e))];
        }
      }
      const selectedChanged = selectRecorded(findings, new Set(picked));
      recorded = [...unchanged, ...selectedChanged]; // auto-kept unchanged + the user's picks
    }
    // #790: offer the baseline-only entries (reverted-to-default / removed since record) as an
    // explicit DROP multiselect — default UNSELECTED, so leaving the prompt PRESERVES the watch
    // (unselected = keep). Dropping a recorded watch is an accept-drift action, so it is opt-in.
    // Skipped on the per-finding path (the action picker owns the decision; unrelated entries
    // must not be dropped by it).
    if (dropCandidates.length > 0 && !preselectedKeys) {
      const dropPrompt = await bulkMultiselect(
        recordDropMessage(stackName, region),
        dropCandidates.map((e) => ({
          value: recordedKey(e),
          label: dropRecordLabel(e),
          selected: false, // default keep — dropping is an explicit accept-drift opt-in
        }))
      );
      if (dropPrompt === undefined) {
        console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
        return { wrote: false, refused: false };
      }
      for (const key of dropPrompt) droppedKeys.add(key);
      refreshedOnly = false;
    }
    // #790: re-append the baseline-only entries the user did NOT drop, so a re-record preserves
    // watched values that reverted-to-default / were removed (they keep reporting as drift).
    recorded = [...recorded, ...dropCandidates.filter((e) => !droppedKeys.has(recordedKey(e)))];
    // The FINAL written set being empty (no unchanged + nothing picked) writes an EMPTY
    // baseline. Since R62 that no longer arms revert removal (unrecorded values stay
    // guarded per entry) — it just records "I decided nothing", so the values keep
    // being reported as unrecorded. Still confirm: writing a file that changes nothing
    // is more likely a mis-keyed multiselect than an intent (R19, defanged by R62).
    // Skipped on the per-finding path: the picker is the decision, no extra confirm.
    if (recorded.length === 0 && !preselectedKeys) {
      const proceed = await confirm({
        message: `${stackLabel(stackName, region)}: record nothing? This writes an EMPTY baseline — every undeclared value stays reported as unrecorded.`,
        initialValue: false,
      });
      if (isCancel(proceed) || !proceed) {
        console.error(`note: ${stackName}: record cancelled — baseline unchanged`);
        return { wrote: false, refused: false };
      }
    }
  }
  // #790: ensure every baseline-only entry the user did NOT explicitly drop is in the written
  // set — under --yes / the per-finding path the interactive drop picker never ran, so append
  // them here (deduped by key, so a re-append after the interactive merge is a no-op). Without
  // this, `writeBaseline`'s full-replace would silently drop a reverted-to-default / removed
  // recorded value that `check` force-surfaces as drift.
  const presentKeys = new Set(recorded.map(recordedKey));
  for (const e of dropCandidates)
    if (!droppedKeys.has(recordedKey(e)) && !presentKeys.has(recordedKey(e))) recorded.push(e);
  const { path, count } = await writeBaseline(
    stackName,
    region,
    desired.accountId,
    findings,
    desired.rawTemplate,
    recorded,
    // full resource list (read-clean resources are snapshot-complete too) +
    // previous baseline so completeness stays monotonic across re-records (R62) +
    // #674: per-resource physical id so a later REPLACING deploy can void stale entries
    {
      allLogicalIds: desired.resources.map((r) => r.logicalId),
      previous: existing,
      physicalIdByLogical: physicalIdsByLogical(desired.resources),
    }
  );
  // #868: suppress the human success line under --json (the caller prints a JSON element);
  // notes/warnings below still go to stderr, so stdout stays pure JSON.
  if (!p.json)
    console.log(style.ok(recordOutcomeMessage(stackName, path, count, refreshedOnly, !!existing)));
  // record's scope excludes declared/deleted: if such drift is present, say so —
  // it was NOT approved by this record and still stands (R117).
  const scopeNote = recordScopeNote(stackName, findings);
  if (scopeNote) console.error(scopeNote);
  return { wrote: true, refused: false, count, path };
}

// ---- ignore ----

export interface IgnoreStackParams {
  stackName: string;
  // baseline-reconciled findings — ignore targets the declared + undeclared tiers
  // (the same set applyIgnores can re-tag). Already-ignored findings are tier
  // `ignored`, so they never re-appear here.
  findings: Finding[];
  yes: boolean;
  interactive: boolean; // whether the multiselect decision prompt may be shown (TTY only)
  // Current identity scope, stamped onto each written rule (issue #757) so an ignore
  // does not leak to a same-named stack in another account/region. Optional only for
  // callers that cannot resolve them; a missing field is omitted from the rule (match-any).
  accountId?: string | undefined;
  region?: string | undefined;
  // #868: under `ignore --json` the human lines are suppressed (the caller emits a JSON
  // element); notes/errors still go to stderr. Defaults to text mode (check's path unaffected).
  json?: boolean;
}

/**
 * Outcome of a per-stack ignore.
 *  - `wrote`: at least one NEW rule was appended to `.cdkrd/ignore.yaml`.
 *  - `refused`: true ONLY when a decision was required (ignorable findings present)
 *    but the run is non-interactive and `--yes` was not passed — like record, ignore
 *    refuses rather than ignoring everything by default.
 *  - `added`: how many new rules were written (0 when all were already present, or on
 *    a cancel/refusal).
 */
export interface IgnoreResult {
  wrote: boolean;
  refused: boolean;
  added: number;
  path?: string; // #868: the .cdkrd/ignore.yaml written (for --json)
}

/** Header for ignore's multiselect. The key hints are rendered by `bulkMultiselect`
 *  itself, so this is just the one-line prompt. Pure + exported for unit tests. */
export function ignoreSelectMessage(stackName: string, region: string): string {
  return `${stackLabel(stackName, region)}: select drift to ignore — stops reporting it (writes .cdkrd/ignore.yaml)`;
}

// Unique per-finding key for the multiselect (logicalId+path is unique within a stack;
// the WRITTEN rule is ignoreRuleFor, which may instead use the friendlier constructPath).
const ignoreFindingKey = (f: Finding): string => `${f.logicalId}::${f.path}`;

/**
 * The ignore multiselect rows. EVERY row starts UNSELECTED (→ selects all) — mirroring
 * revert's picker (R137): ignore STOPS watching permanently, and check's interactive flow
 * can route folded undeclared inventory here, so a default-all selection would let an
 * Enter ignore values the user never saw in the report. Opt-in, not opt-out. Pure +
 * exported so the "starts unselected" invariant is unit-tested without a TTY.
 */
export function ignoreSelectOptions(
  ignorable: Finding[],
  stackName = ''
): { value: string; label: string; selected: boolean }[] {
  return ignorable.map((f) => {
    const id = f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId;
    return {
      value: ignoreFindingKey(f),
      label: `${id}${f.path ? `.${f.path}` : ''} (${f.tier})`,
      selected: false,
    };
  });
}

/**
 * Write `ignore` rules into `.cdkrd/ignore.yaml` for the chosen declared/undeclared
 * findings — they stop being reported entirely (re-tagged `ignored` on the next check),
 * the "stop watching" counterpart to record's "keep watching". Interactive runs pick
 * WHICH findings to ignore (default NONE selected — → selects all, R137); `--yes`
 * ignores all shown.
 * Non-interactively without `--yes` it refuses (a required decision, like record, R38).
 * Idempotent: rules already in the file are reported, not duplicated. Shared by `cdkrd
 * ignore` and (PR-B2) check's interactive flow, so both write rules identically.
 */
export async function ignoreStack(p: IgnoreStackParams): Promise<IgnoreResult> {
  const { stackName, findings, yes, interactive, accountId = '', region = '' } = p;
  // ignore is symmetric with revert (declared + undeclared + added), unlike record
  // (undeclared only) — it fills the gap of accepting a DECLARED or out-of-band ADDED
  // drift in-tool.
  const ignorable = findings.filter(
    (f) => f.tier === 'declared' || f.tier === 'undeclared' || f.tier === 'added'
  );
  if (ignorable.length === 0) {
    if (!p.json) console.log(style.clean(`${stackName}: no ignorable drift to ignore.`));
    return { wrote: false, refused: false, added: 0 };
  }
  let chosen = ignorable;
  if (!yes) {
    if (!interactive) {
      console.error(
        `error: ignore needs a decision — pass --yes to ignore ALL shown drift, or run interactively`
      );
      return { wrote: false, refused: true, added: 0 };
    }
    const picked = await bulkMultiselect(
      ignoreSelectMessage(stackName, region),
      ignoreSelectOptions(ignorable, stackName)
    );
    if (picked === undefined) {
      console.error(`note: ${stackName}: ignore cancelled — config unchanged`);
      return { wrote: false, refused: false, added: 0 };
    }
    const set = new Set(picked);
    chosen = ignorable.filter((f) => set.has(ignoreFindingKey(f)));
    if (chosen.length === 0) {
      console.error(`note: ${stackName}: nothing selected — config unchanged`);
      return { wrote: false, refused: false, added: 0 };
    }
  }
  const { path, added, alreadyPresent } = await addIgnoreRules(
    chosen.map((f) => ignoreRuleFor(f, stackName, accountId, region))
  );
  if (!p.json) {
    if (added.length > 0) {
      const dup = alreadyPresent.length > 0 ? `, ${alreadyPresent.length} already present` : '';
      console.log(style.ok(`ignore rule(s) added: ${path} (${added.length} new${dup})`));
    } else {
      console.log(
        style.note(
          `${stackName}: all ${alreadyPresent.length} selected rule(s) already present — config unchanged`
        )
      );
    }
  }
  return { wrote: added.length > 0, refused: false, added: added.length, path };
}

// ---- revert ----

export interface PlanDisplayOptions {
  verbose?: boolean; // expand the NOT-revertable per-reason summary to the full per-finding list
  unrecordedGuidance?: boolean; // unrecorded values present → lead with the record-or-remove fork
}

/**
 * Render the revert plan (pure — exported for unit tests; printPlan logs it).
 * Revertable items are ALWAYS full detail — confirming what will be written to AWS
 * is the point of the plan. NOT-revertable findings fold into one line per reason
 * (count + reason — same idea as check's `info:` footer, R25/R35); `--verbose`
 * expands them to the full per-finding list.
 */
export function formatPlan(
  stackName: string,
  region: string,
  plan: RevertPlan,
  opts: PlanDisplayOptions = {}
): string[] {
  const lines: string[] = [`\n=== revert: ${stackName} (${region}) ===`];
  if (opts.unrecordedGuidance) {
    // A fork, not a sequence (R55): recording these values endorses them (they
    // leave the report) — it is NOT a step toward reverting them.
    lines.push(
      `\nnote: ${stackName} has unrecorded value(s) — never recorded, so there is no recorded state to restore.`,
      '      If the live values are RIGHT, record them (they leave the report);',
      '      if they should be REMOVED, re-run revert with --remove-unrecorded.'
    );
  }
  // A resource can split into MORE THAN ONE plan item (a Cloud Control `cc` item plus a
  // prop-scoped `sdk` item route through different writers — e.g. a Logs LogGroup whose
  // RetentionInDays reverts via CC while BearerTokenAuthenticationEnabled reverts via the
  // SDK writer). Merge them into ONE block per resource so the listing reads per-resource,
  // not per-writer-group (two identical-header blocks for the same resource is confusing).
  const planByResource = new Map<
    string,
    { displayId: string; resourceType: string; humans: string[] }
  >();
  for (const item of plan.items) {
    const g = planByResource.get(item.logicalId);
    // #967: a CONTRACT op (null-husk strip) is plumbing, not a user-chosen revert — omit
    // it from the itemized plan (it is not counted or selectable either). A resource whose
    // only ops are contract ops never reaches here: filterRevertPlan drops such an item.
    const humans = item.ops.filter((op) => !isContractOp(op)).map((op) => op.human);
    if (g) g.humans.push(...humans);
    else
      planByResource.set(item.logicalId, {
        displayId: item.displayId,
        resourceType: item.resourceType,
        humans,
      });
  }
  for (const g of planByResource.values()) {
    lines.push(`\n  ${g.displayId} (${g.resourceType})`);
    for (const h of g.humans) lines.push(`    - ${h}`);
  }
  if (plan.notRevertable.length > 0) {
    if (opts.verbose) {
      lines.push(`\n  NOT revertable (${plan.notRevertable.length}):`);
      for (const n of plan.notRevertable)
        lines.push(`    - ${n.displayId}.${n.path} (${n.resourceType}) — ${n.reason}`);
    } else {
      const counts = new Map<string, number>();
      for (const n of plan.notRevertable) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1);
      const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      groups.forEach(([reason, count], i) => {
        lines.push(
          i === 0
            ? `\n  NOT revertable: ${count} (${reason})`
            : `                · ${count} (${reason})`
        );
      });
      lines.push('    (run with --verbose for the full list)');
    }
  }
  return lines;
}

/** Collapse per-item apply results into ONE outcome per resource (logical id). A
 *  resource that split into a `cc` item and a prop-scoped `sdk` item produced two
 *  results; print a single `reverted:` line for it when every item succeeded, and a
 *  single `FAILED:` line (joining the failing writers' errors) when any did not — so a
 *  fully reverted resource never prints twice and a partial failure is never shown as a
 *  plain success. Insertion order (first item per resource) is preserved. */
export function summarizeRevertResults(
  applied: readonly {
    logicalId: string;
    displayId: string;
    ok: boolean;
    error?: string;
    hint?: string;
  }[]
): { displayId: string; ok: boolean; error?: string; hint?: string }[] {
  const byResource = new Map<
    string,
    { displayId: string; ok: boolean; errors: string[]; hints: string[] }
  >();
  for (const a of applied) {
    const g = byResource.get(a.logicalId) ?? {
      displayId: a.displayId,
      ok: true,
      errors: [],
      hints: [],
    };
    if (!a.ok) {
      g.ok = false;
      if (a.error) g.errors.push(a.error);
      // Collapse duplicate hints (a cc + sdk split can both fail transiently) to one line.
      if (a.hint && !g.hints.includes(a.hint)) g.hints.push(a.hint);
    }
    byResource.set(a.logicalId, g);
  }
  return [...byResource.values()].map((g) =>
    g.ok
      ? { displayId: g.displayId, ok: true }
      : {
          displayId: g.displayId,
          ok: false,
          error: g.errors.join('; '),
          ...(g.hints.length > 0 && { hint: g.hints.join('; ') }),
        }
  );
}

function printPlan(
  stackName: string,
  region: string,
  plan: RevertPlan,
  opts: PlanDisplayOptions
): void {
  // formatPlan stays pure/plain (unit-tested verbatim); only the banner line is
  // styled here, at the printing edge.
  for (const line of formatPlan(stackName, region, plan, opts)) {
    console.log(line.startsWith('\n=== ') ? '\n' + style.header(line.slice(1)) : line);
  }
}

export interface RevertStackParams {
  stackName: string;
  region: string;
  gathered: GatherResult; // the check/revert gather (findings + desired + schemas)
  baseline: BaselineFile | undefined;
  config: CdkrdConfig; // .cdkrd/ignore.yaml ignore rules (ignored findings drop out of the plan)
  dryRun: boolean;
  yes: boolean;
  removeUnrecorded: boolean;
  // `revert --force` (#1175): proceed with the AWS write even when the pre-write DescribeStacks
  // re-read (#786) reports the stack mid-operation (`*_IN_PROGRESS`). The default is fail-CLOSED
  // — that refusal is the #786 safety property. `--force` is the explicit opt-out for an operator
  // who knowingly reverts against an in-progress stack (e.g. a wedged UPDATE_IN_PROGRESS that will
  // never settle). It ONLY skips the in-progress refusal; the loud mid-operation warning still
  // prints, and the confirm (--yes) and every other safety are untouched. Defaults to false.
  force?: boolean;
  verbose: boolean; // expand the NOT-revertable summary to the full list
  interactive: boolean; // whether the confirm prompt may be shown (TTY only)
  // check's "Decide per finding" path (R121): the user already chose WHICH findings to
  // revert (passed in via gathered.findings), so revertStack skips its own op-multiselect
  // and reverts every op of the plan — but STILL shows the AWS-write confirm. Off by
  // default, so the standalone `revert` keeps its per-op multiselect.
  autoSelectAll?: boolean;
  // #756: check's "Decide per finding" path assigns `revert` to a SUBSET of findings.
  // The reconciliation against the baseline (applyBaseline: currentPaths / skippedLogical
  // / deletedLogical / underDeclaredDrift) MUST see the FULL finding set — else every
  // recorded entry whose healthy, matching live finding was filtered out looks "removed
  // since record" and synthesizes a phantom restore op the user never chose. So the caller
  // passes the UNFILTERED findings in `gathered.findings` AND the chosen finding identities
  // here; the plan is then restricted to ops for exactly these findings. Key format is
  // `${logicalId}::${path}` (+ `[attributeKey]` when present) — identical to interactive
  // -resolve.ts's keyOf. Undefined = revert every planned finding (standalone `revert`).
  selectedFindingKeys?: Set<string>;
  // Delay before the single convergence re-read retry (SDK-writer paths can lag
  // behind their API response — eventual consistency). Overridable so unit tests
  // don't sleep for real.
  convergeRetryDelayMs?: number;
  // `revert --wait[=DURATION]` (issue #467): on a TRANSIENT "resource is mid-update"
  // failure (RSLVR-00705 & friends), keep retrying the write until the resource settles
  // (up to this many ms) instead of stopping at the short default backoff — so a
  // minutes-long UPDATING window converges in one command. undefined = default backoff.
  waitMs?: number;
  // Injected clock/sleep for the wait path so deadline-mode unit tests don't sleep.
  waitNow?: () => number;
  waitSleep?: (ms: number) => Promise<void>;
  // #868: under `revert --json` all human output (the plan, per-op result lines, the
  // convergence verdict) is suppressed; the caller emits a machine JSON element from the
  // returned outcome. Notes/warnings still go to stderr. Defaults to text mode.
  json?: boolean;
}

const CONVERGE_RETRY_DELAY_MS = 3000;

/**
 * Outcome of a per-stack revert.
 *  - `exit`: the exit contribution — 0 clean / 1 drift remains (including "drift
 *    exists but nothing is revertable", R35) / 2 apply failure (or a non-interactive
 *    write refusal).
 *  - `aborted`: true ONLY when the user cancelled the confirm prompt (no AWS write
 *    happened). The standalone `revert` command treats an abort as exit 0 (nothing
 *    changed), but `check`'s interactive flow must NOT let an abort drop a drifted
 *    stack to exit 0 — it keeps the pre-revert exit 1 (symmetric with "Nothing").
 *    See R30.
 */
export interface RevertOutcome {
  exit: number;
  aborted: boolean;
  reverted?: number; // #868: resources successfully reverted (for --json); absent = 0
  failed?: number; // #868: resources whose revert op failed (for --json); absent = 0
  // #1096: under --dry-run the human "(dry-run) would apply N op(s) to M resource(s)"
  // summary is silenced (out() is a no-op under --json), so a scripted consumer could not
  // tell a would-apply-N-ops preview from a clean no-op. Carry the SAME counts the human
  // summary computes so the --json element is self-describing. Present only on --dry-run.
  plannedOps?: number; // ops a real revert would apply (Σ item.ops.length)
  plannedResources?: number; // resources those ops touch (plan.items.length)
  // #1096: why the revert refused to plan/apply anything — the "nothing revertable" reason
  // (drift/unrecorded remains) or the non-interactive "pass --yes" refusal. Present only on a
  // refusal so a scripted consumer sees WHY an exit-1/exit-2 element carries no reverted ops.
  refusedReason?: string;
}

/**
 * Build the revert plan from the gather's findings + baseline, show it, confirm
 * (unless --yes / --dry-run), apply via Cloud Control / SDK writers, then re-gather
 * to verify convergence. Does NOT re-gather to build the plan (uses the passed
 * gather) — only the convergence re-check re-gathers.
 */
// R113: whether to include the REMOVE of standout undeclared (unrecorded) values in
// a revert. The explicit `--remove-unrecorded` flag always includes them. Otherwise
// include them ONLY when an interactive multiselect will be shown to gate them
// per-item (TTY and not --yes) — its unselected-by-default REMOVE rows ARE the
// consent the flag provides. A no-prompt run (--yes or non-TTY) keeps requiring the
// flag, since there is nothing to opt in with. Pure + exported for tests.
export function includeUnrecordedRemovals(
  removeUnrecorded: boolean,
  interactive: boolean,
  yes: boolean
): boolean {
  return removeUnrecorded || (interactive && !yes);
}

// #760: the ops a cc-kind item ACTUALLY sends to Cloud Control are not `item.ops` as
// built — three augmentations rewrite/extend them so the read-modify-write UpdateResource
// converges (and does not clobber managed tags / write-only credentials):
//   - tagPreservingOps       — re-attach live aws:* managed tags onto any /Tags op
//   - writeOnlyReincludeOps   — re-send declared write-only values (secrets/passwords) CC drops
//   - rejectedEmptyStripOps   — drop service-echoed empty arrays the provider rejects on update
// These MUST be computed BEFORE the plan is printed / the op count is confirmed / the
// --dry-run count is taken, so the preview is exactly the patch that will be sent (the
// user must see a write-only-reinclude before consenting to the AWS write). This helper is
// the SINGLE place the augmentation happens: the preview and the apply consume the same
// augmented ops, so they can never drift. sdk / delete items pass through unchanged.
export function augmentCcItemOps(
  item: RevertItem,
  schemas: Map<string, SchemaInfo>,
  liveByLogical: Map<string, Record<string, unknown>>,
  declaredByLogical: (logicalId: string) => Record<string, unknown> | undefined
): RevertItem {
  if (item.kind !== 'cc') return item;
  const liveRaw = liveByLogical.get(item.logicalId);
  // Re-attach the live aws:* managed tags onto any /Tags op, so the Cloud Control
  // read-modify-write does not tell the provider to UNtag them.
  const tagged = tagPreservingOps(item.ops, liveRaw);
  // Re-include write-only props the Cloud Control read-modify-write would drop
  // (cdkd #812 — e.g. ECS Service VolumeConfigurations, IAM User LoginProfile.Password).
  const extra = writeOnlyReincludeOps(
    declaredByLogical(item.logicalId),
    schemas.get(item.resourceType),
    tagged
  );
  // Drop service-echoed empty arrays the service itself rejects on update
  // (#481 — VpcLattice Rule HeaderMatches []). Live-gated + ancestor-aware.
  const strip = rejectedEmptyStripOps(item.resourceType, [...tagged, ...extra], liveRaw);
  const combined = [...tagged, ...extra, ...strip];
  // Preserve the historical shape: only replace the ops when an augmentation actually
  // added a row (combined.length > tagged.length). tagPreservingOps rewrites in place
  // (never changes the count), so a pure tag rewrite still flows through `tagged`.
  const ops = combined.length > tagged.length ? combined : tagged;
  return { ...item, ops };
}

// #760: a batch UpdateResource / SDK-writer failure carries only the provider's message,
// which rarely names WHICH op in the patch failed. Prefix the error with the item's op
// path(s) so the FAILED line attributes the failure to the property revert(s) it carried —
// `[/Foo, /Bar]: <error>`. A `delete`-kind item has a single pseudo-op with no meaningful
// property path (it deletes the whole resource), so leave its error unchanged. When the
// error already leads with the same attribution (idempotent), it is not doubled. Pure.
export function attributeOpFailure(item: RevertItem, error: string): string {
  if (item.kind === 'delete') return error;
  const paths = [...new Set(item.ops.map((o) => o.path).filter((p) => p.length > 0))];
  if (paths.length === 0) return error;
  const prefix = `[${paths.join(', ')}]`;
  return error.startsWith(prefix) ? error : `${prefix}: ${error}`;
}

// Apply augmentCcItemOps to every cc-kind item so the returned plan's ops ARE the ops that
// will be sent to AWS — feeding one augmented plan to BOTH the preview (printPlan / dry-run
// count / confirm) and the apply loop (#760).
export function augmentRevertPlan(
  plan: RevertPlan,
  schemas: Map<string, SchemaInfo>,
  liveByLogical: Map<string, Record<string, unknown>>,
  declaredByLogical: (logicalId: string) => Record<string, unknown> | undefined
): RevertPlan {
  return {
    ...plan,
    items: plan.items.map((item) =>
      augmentCcItemOps(item, schemas, liveByLogical, declaredByLogical)
    ),
  };
}

export async function revertStack(p: RevertStackParams): Promise<RevertOutcome> {
  const {
    stackName,
    region,
    gathered,
    baseline,
    config,
    dryRun,
    yes,
    removeUnrecorded,
    force,
    verbose,
    interactive,
    autoSelectAll,
    selectedFindingKeys,
    waitMs,
    waitNow,
    waitSleep,
  } = p;
  // #868: human stdout sink — silenced under --json so stdout carries only the JSON the
  // caller prints. console.error (notes/warnings) is left untouched (stderr stays informative).
  const out = p.json ? () => {} : console.log;
  let worst = 0;
  // R113: a standout undeclared value is surfaced to the user as [Potential Drift] (it is
  // NOT a folded default — we deliberately show it), so, like declared drift, it
  // belongs in the revert list. Reverting an undeclared value REMOVES it (cdk drift
  // reports the same values and `cdk deploy --revert-drift` removes them). The
  // multiselect's REMOVE rows start UNSELECTED, so listing them is the per-item
  // consent that `--remove-unrecorded` provides non-interactively — no flag needed in
  // a gated prompt. A no-prompt run (--yes or non-TTY) has no multiselect to gate, so
  // it still requires the explicit flag.
  const includeRemovals = includeUnrecordedRemovals(removeUnrecorded, interactive, yes);
  const declaredByLogical = declaredKeysByLogical(gathered.desired.resources);
  // physicalId + constructPath maps so a synthesized "baseline value removed since
  // record" finding carries them — physicalId lets `revert` actually restore the
  // removed value (else buildRevertPlan rejects it "no physical id"); constructPath
  // lets a constructPath-form ignore rule match it during applyIgnores.
  const physicalIdByLogical = physicalIdsByLogical(gathered.desired.resources);
  const constructPathByLogical = constructPathsByLogical(gathered.desired.resources);
  // #675: the current template's logical-id set so applyBaseline can fold recorded
  // entries whose resource was removed from the template. #674 reuses physicalIdByLogical
  // (LIVE physical ids) to void entries recorded against a since-REPLACED resource.
  const allLogicalIds = gathered.desired.resources.map((r) => r.logicalId);
  const baselineOpts = {
    declaredByLogical,
    physicalIdByLogical,
    constructPathByLogical,
    allLogicalIds,
  };
  const reconciled = applyIgnores(
    applyBaseline(gathered.findings, baseline, { ...baselineOpts, warn: console.error }),
    { stackName, accountId: gathered.desired.accountId, region },
    config
  );
  // #756: when the per-finding flow chose a SUBSET to revert, applyBaseline above ran over
  // the UNFILTERED findings (so its removal-synthesis reconciliation saw reality — no
  // phantom "removed since record" restore ops for entries whose healthy live finding the
  // user simply did not pick). Now narrow the plan input to EXACTLY the chosen findings, so
  // the AWS writes correspond to reverting only those — never a skipped / ignored / unpicked
  // recorded entry, and no same-value churn. Undefined = standalone `revert`: plan them all.
  const drifted =
    selectedFindingKeys === undefined
      ? reconciled
      : reconciled.filter((f) => selectedFindingKeys.has(findingKeyOf(f)));
  // Resolve the declared model per logical id — needed both by writeOnlyReincludeOps (to
  // re-include declared write-only values) and by the apply loop (writer `declared` arg).
  const resByLogical = new Map(gathered.desired.resources.map((res) => [res.logicalId, res]));
  const declaredForLogical = (logicalId: string): Record<string, unknown> | undefined =>
    resByLogical.get(logicalId)?.declared;
  // #760: the cc-kind ops actually sent to Cloud Control are augmented (tag-preserve /
  // write-only-reinclude / empty-strip). Bind the augmentation once so the SAME transform
  // feeds the preview (printPlan / --dry-run count / confirm count) and the apply loop.
  // Before this, augmentation ran ONLY at apply time — the confirmed op count and printed
  // plan omitted ops that were then sent to AWS (notably write-only re-includes, a real
  // extra write of secrets/passwords the user never saw). The augmentation is a pure
  // function of an item's real ops, so it is applied to the FILTERED plan after the
  // per-op multiselect (the multiselect selects only real ops; re-augmenting the survivors
  // keeps the sent patch valid) — leaving the printed/confirmed count exactly the patch
  // that will be sent.
  const augment = (pl: RevertPlan): RevertPlan =>
    augmentRevertPlan(pl, gathered.schemas, gathered.liveByLogical, declaredForLogical);
  let plan = buildRevertPlan(drifted, baseline, {
    removeUnrecorded: includeRemovals,
    schemas: gathered.schemas,
    siblingSgRules: buildSiblingSgRules(gathered.desired),
    stackName,
    // raw live models so a CC revert patch can strip a bare-null array husk out of CC's
    // server-side model (#641 symptom 2), else the unrelated-property revert fails validation.
    liveByLogical: gathered.liveByLogical,
    // computed over the FULL reconciled findings — `drifted` may be the picked subset,
    // which never includes the (unpickable) GetTemplate-masked readGaps the whole-array
    // mask guard correlates against.
    maskReadGapKeys: maskReadGapKeysOf(reconciled),
  });

  if (plan.items.length === 0 && plan.notRevertable.length === 0) {
    out(style.clean(`${stackName} (${region}): no drift to revert.`));
    return { exit: 0, aborted: false };
  }
  // #760: print the AUGMENTED plan so the preview shows the tag-preserve / write-only-reinclude
  // / empty-strip ops that will actually be sent — the user must see them before consenting.
  if (!p.json)
    printPlan(stackName, region, augment(plan), {
      verbose,
      // Only when the unrecorded guard actually fires: with removals included the plan
      // REMOVES those values, so a "no revert target — record first" note would
      // contradict the plan printed right below it (R35 review).
      unrecordedGuidance: !includeRemovals && drifted.some((f) => f.unrecorded === true),
    });
  if (plan.items.length === 0) {
    // Findings exist but none are revertable (R35). That is NOT the clean
    // "no drift to revert" case — the findings still stand, so exit 1 (the same
    // "drift remains" semantics as a post-apply non-convergence; not a usage
    // error). Unrecorded values are named as such, not folded into "drift" (R62).
    const dc = driftCount(drifted);
    const uc = unrecordedCount(drifted);
    const parts = [
      ...(dc > 0 ? [`${dc} drift(s)`] : []),
      ...(uc > 0 ? [`${uc} unrecorded value(s)`] : []),
    ];
    const reason = `nothing revertable — ${parts.join(' + ')} remain.`;
    out('\n' + style.drift(reason));
    return { exit: 1, aborted: false, refusedReason: reason };
  }

  if (dryRun) {
    // #760: count the AUGMENTED ops — a --dry-run preview must report the op count that a
    // real revert would SEND, including the tag-preserve / write-only-reinclude / empty-strip
    // ops the apply loop adds. Resource count is unaffected (augmentation never adds items).
    const augmented = augment(plan);
    // #967: count only REAL revert ops — contract ops (null-husk strips) are plumbing,
    // not writes the user chose, so they never inflate the count shown to the user.
    const opCount = realOpCount(augmented);
    out(
      `\n(dry-run) would apply ${opCount} op(s) to ${augmented.items.length} resource(s). No changes made.`
    );
    // #1096: the human line above is silenced under --json — carry the same counts so the
    // JSON element is not mistaken for a clean no-op.
    return {
      exit: 0,
      aborted: false,
      plannedOps: opCount,
      plannedResources: augmented.items.length,
    };
  }
  if (!yes) {
    if (!interactive) {
      const reason =
        'refusing to write to AWS non-interactively — pass --yes to apply (or --dry-run to preview).';
      console.error('\n' + reason);
      return { exit: 2, aborted: false, refusedReason: reason };
    }
    // R57: pick WHICH op(s) to write — symmetric with record's multiselect.
    // RESTORE ops are pre-selected; REMOVE ops start unselected (an explicit
    // per-item opt-in to deleting a live value). Selecting nothing aborts.
    // Skipped on the per-finding path (autoSelectAll): the action picker already chose
    // the findings, so revert every op of the plan — but still confirm the AWS write.
    if (!autoSelectAll) {
      const picked = await bulkMultiselect(
        revertSelectMessage(stackName, region),
        revertSelectOptions(plan)
      );
      if (picked === undefined) {
        out(style.note('aborted.'));
        return { exit: 0, aborted: true };
      }
      plan = filterRevertPlan(plan, new Set(picked));
      if (plan.items.length === 0) {
        out(style.note('nothing selected — aborted.'));
        return { exit: 0, aborted: true };
      }
    }
    // #760: count the AUGMENTED (now possibly filtered) plan so the confirmed op count is
    // exactly the patch that will be sent. The multiselect selected only REAL ops; augment
    // re-derives the coupled tag-preserve / write-only-reinclude / empty-strip ops for the
    // survivors. The canonical `plan = augment(plan)` runs once just below (before apply),
    // so both this confirm count and the apply loop see the same augmented ops.
    const confirmPlan = augment(plan);
    // #967: count only REAL revert ops for the confirm prompt (contract null-husk strips
    // are plumbing, not user-chosen writes). The full augmented plan is still applied.
    const opCount = realOpCount(confirmPlan);
    const deleteCount = confirmPlan.items.filter((i) => i.kind === 'delete').length;
    const ok = await confirm({
      message: revertConfirmMessage(
        stackName,
        region,
        opCount,
        plan.notRevertable.length,
        deleteCount
      ),
      // A destructive AWS write must NOT default to Yes — Enter/default is No (#1055),
      // matching record's empty-baseline confirm (initialValue: false above).
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      out(style.note('aborted.'));
      return { exit: 0, aborted: true };
    }
  }

  // #760: from here `plan` carries the AUGMENTED cc ops (tag-preserve / write-only-reinclude
  // / empty-strip) — exactly what was previewed / dry-run-counted / confirmed above. The apply
  // loop sends these ops verbatim (no per-item re-augmentation), so the sent patch cannot drift
  // from the preview. Augmented ONCE here for BOTH the --yes/non-interactive path (which skipped
  // the block above) and the interactive path (whose confirmPlan mirrored this).
  plan = augment(plan);

  // TOCTOU gate (#786): the stack was stable at gather time, but it may have entered a
  // `cdk deploy` while the confirm prompt sat open. Re-read StackStatus RIGHT before the
  // write and REFUSE when it is mid-operation — a revert now would fight the in-flight
  // deploy, writing OLD values onto an updating stack. Fails CLOSED by default. `--force`
  // (#1175) is the explicit opt-out for an operator who knowingly reverts against an
  // in-progress stack (e.g. a wedged UPDATE_IN_PROGRESS that will never settle): it skips
  // the refusal but STILL prints the mid-operation state loudly, so the operator sees it.
  const inProgress = await stackInProgressRefusal(stackName, region);
  if (inProgress) {
    if (force) {
      console.error('\nwarning: ' + inProgress + ' Proceeding anyway (--force).');
    } else {
      console.error('\n' + inProgress);
      return { exit: 2, aborted: false, refusedReason: inProgress };
    }
  }

  const cc = new CloudControlClient({ region, ...CLIENT_TIMEOUTS });
  // `added` delete items have a SYNTHESIZED logicalId (not a template resource), so the
  // scoped convergence re-read below cannot regenerate them — a SUCCESSFUL delete then
  // correctly vanishes from `post`, but a FAILED one would vanish too (reading as CLEAN).
  // Track the failed ones and re-add their findings so they still count as drift.
  const failedDeleteIds = new Set<string>();
  // #631: a FAILED update/sdk op (the SNS FilterPolicyScope `remove` that hard-fails
  // InvalidRequest[null]) must count as UNCONFIRMED — the same "never claim convergence we
  // could not verify" principle that already covers failed deletes. Without this a FAILED op
  // printed alongside a `CLEAN after revert.` verdict (live-observed 2026-07-08).
  const failedUpdateIds = new Set<string>();
  const applied: {
    logicalId: string;
    displayId: string;
    ok: boolean;
    error?: string;
    hint?: string;
  }[] = [];
  // Per-item transient-retry options (issue #467). `--wait` turns the short default
  // backoff into a deadline-bounded wait so a minutes-long UPDATING window (RSLVR-00705)
  // converges in one command; a non-delete item runs ONCE so it gets its OWN wait budget.
  // `onRetry` prints a per-retry progress line so the wait never looks frozen (see #477's
  // spinner ethos). `deadlineMsOverride` pins a SHARED deadline for the delete batch (#969):
  // `applyRevertDeletes` re-invokes this builder for the SAME item on every dependency-aware
  // pass, so without a shared deadline a persistent throttle on a delete would re-arm a fresh
  // full `--wait` budget each pass (a genuine spanning-throttle could wait N × waitMs). One
  // deadline per revert run bounds the whole delete phase to a single budget.
  const clock = waitNow ?? Date.now;
  const buildRetryOpts = (displayId: string, deadlineMsOverride?: number): RetryOptions => ({
    ...(waitMs !== undefined && { deadlineMs: deadlineMsOverride ?? clock() + waitMs }),
    ...(waitNow && { now: waitNow }),
    ...(waitSleep && { sleep: waitSleep }),
    onRetry: ({ attempt, delayMs, hint }) => {
      const reason = (hint ?? 'transient error').split(' — ')[0];
      const secs = Math.max(1, Math.round(delayMs / 1000));
      out(style.note(`    ↻ ${displayId}: ${reason} — retry ${attempt} (next in ${secs}s)…`));
    },
  });
  // #952: stream each resource's `reverted:`/`FAILED:` line the moment its last item
  // resolves — instead of buffering the whole batch and printing only after every item
  // completes. On a long (10-item) revert the user now sees progress as it happens, and a
  // Ctrl-C mid-apply leaves a visible trace of what already succeeded/failed rather than
  // nothing. To avoid double-printing (the end-of-batch summary still runs for the --json
  // tallies), we track how many items each resource contributes and print its collapsed
  // outcome once all of them have landed in `applied`. A resource that split into a `cc` +
  // `sdk` item (two results, same logicalId) still prints exactly ONE line, identical to
  // what summarizeRevertResults would render — the shared helper guarantees byte-for-byte
  // parity. Streaming goes through `out`, so it is already suppressed under --json.
  const itemsPerLogical = new Map<string, number>();
  for (const item of plan.items)
    itemsPerLogical.set(item.logicalId, (itemsPerLogical.get(item.logicalId) ?? 0) + 1);
  const streamedLogical = new Set<string>();
  const streamResultLine = (logicalId: string): void => {
    if (streamedLogical.has(logicalId)) return;
    const forResource = applied.filter((a) => a.logicalId === logicalId);
    if (forResource.length < (itemsPerLogical.get(logicalId) ?? 0)) return;
    streamedLogical.add(logicalId);
    for (const s of summarizeRevertResults(forResource)) printRevertResultLine(s);
  };
  // Shared renderer for one collapsed per-resource outcome — used BOTH by the streaming
  // path (as each resource finishes) and, for anything not yet streamed, by the
  // end-of-batch pass below. Kept as one function so the two paths cannot drift in format.
  const printRevertResultLine = (s: {
    displayId: string;
    ok: boolean;
    error?: string;
    hint?: string;
  }): void => {
    if (s.ok) {
      out(style.ok(`  reverted: ${s.displayId}`));
    } else {
      out(style.fail(`  FAILED: ${s.displayId} — ${s.error}`));
      // Transient "resource is mid-update" failure that survived the retries: add a
      // targeted hint so the user knows this is retry-later, not a real failure. When we
      // did NOT already wait (`--wait` off), point at it as the one-command settle path.
      if (s.hint) {
        const suffix =
          waitMs === undefined ? ' (or re-run with --wait to block until it settles)' : '';
        out(style.note(`    ↳ ${s.hint}${suffix}`));
      }
    }
  };
  // Partition `delete`-kind items out of the main loop: they are applied as a batch AFTER
  // all non-delete items, with dependency-aware retry (issue #765). Non-deletes (plan.ts
  // already orders them first) keep their inline path and MUST run before the deletes.
  const deleteItems = plan.items.filter((i) => i.kind === 'delete');
  for (const item of plan.items) {
    if (item.kind === 'delete') continue;
    let r: { ok: boolean; error?: string; hint?: string };
    if (item.kind === 'sdk') {
      const res = resByLogical.get(item.logicalId);
      // Same transient-retry wrapper as the Cloud Control path (issue #467): an SDK
      // writer can also throw a "resource is currently updating" error that settles on
      // a retry, and exhausted retries carry the targeted hint.
      r = await retryTransient(async () => {
        try {
          const writer = resolveSdkWriter(item.resourceType, item.ops);
          if (!writer) throw new Error(`no SDK writer for ${item.resourceType}`);
          // A Cloud-Control-routed nested writer addresses the resource by the composite CC
          // identifier (e.g. AWS::ApiGateway::Stage `RestApiId|StageName`) the READ path
          // resolves — pass it so its GetResource/UpdateResource doesn't ValidationException
          // on the bare physical id. Falls back to the physical id when no adapter applies.
          // Await the adapter (MAY be async — #1317 EIP) BEFORE `?? physicalId`.
          const adapted = await CC_IDENTIFIER_ADAPTERS[item.resourceType]?.(
            item.physicalId,
            res?.declared ?? {},
            region,
            gathered.desired.accountId
          );
          const identifier = adapted ?? item.physicalId;
          await writer(
            {
              physicalId: item.physicalId,
              identifier,
              declared: res?.declared ?? {},
              region,
              accountId: gathered.desired.accountId,
              resourceType: item.resourceType,
            },
            item.ops
          );
          return { ok: true };
        } catch (e) {
          return { ok: false, error: errorText(e) };
        }
      }, buildRetryOpts(item.displayId));
    } else {
      const res = resByLogical.get(item.logicalId);
      // Await the adapter (MAY be async — #1317 EIP) BEFORE `?? physicalId`.
      const adapted = await CC_IDENTIFIER_ADAPTERS[item.resourceType]?.(
        item.physicalId,
        res?.declared ?? {},
        region,
        gathered.desired.accountId
      );
      const identifier = adapted ?? item.physicalId;
      // #760: item.ops are ALREADY augmented (tag-preserve / write-only-reinclude /
      // empty-strip) — the whole plan was run through `augment` before the confirm, so what
      // is sent here is exactly what was previewed / confirmed. No per-item re-augmentation.
      r = await applyRevertItem(cc, item, identifier, buildRetryOpts(item.displayId));
    }
    applied.push({
      logicalId: item.logicalId,
      displayId: item.displayId,
      ok: r.ok,
      // #760: a whole-patch UpdateResource / SDK-writer failure names only the resource; the
      // provider error rarely says WHICH op failed. Attribute the failing batch by naming the
      // op path(s) it carried, so a multi-op revert's FAILED line points at the culprit
      // property (`[path]: error`). Cloud Control applies the patch atomically, so any op in
      // the batch could be the cause — naming them all is the honest attribution.
      ...(r.error !== undefined && { error: attributeOpFailure(item, r.error) }),
      ...(r.hint !== undefined && { hint: r.hint }),
    });
    if (!r.ok) worst = Math.max(worst, 2);
    // A failed NON-delete op (this loop no longer runs deletes) — feed the convergence
    // verdict so a FAILED update never rides under a CLEAN summary.
    if (!r.ok) failedUpdateIds.add(item.logicalId);
    // #952: stream this resource's outcome now if this was its last item.
    streamResultLine(item.logicalId);
  }
  // Apply the `delete`-kind items as a dependency-aware batch AFTER the non-deletes
  // (issue #765): a delete that first fails on a DependencyViolation is retried once the
  // pass that frees its dependency has run. Fold each outcome back into applied / worst /
  // failedDeleteIds exactly as the old inline single-item delete path did.
  // ONE deadline for the entire delete phase (#969): computed once here so every
  // dependency-aware pass over the same item shares it, instead of re-arming a fresh
  // `--wait` budget per pass. Undefined without `--wait` (falls back to the default
  // fixed-attempt backoff, unaffected by the deadline).
  const deleteDeadlineMs = waitMs !== undefined ? clock() + waitMs : undefined;
  const deleteOutcomes = await applyRevertDeletes(deleteItems, (item) => {
    // #1386: a type Cloud Control cannot DELETE (AWS::AppSync::ApiKey —
    // UnsupportedActionException) routes through its type-specific SDK deleter instead,
    // wrapped so the batch keeps the identical already-gone / dependency-defer / transient
    // semantics as the CC path. An added finding's synthesized logicalId is
    // `${parentLogicalId}/${ccIdentifier}` (gather.ts addedFinding), so the enumerating
    // PARENT's physical id (e.g. the GraphQLApi ARN DeleteApiKey derives its apiId from)
    // is recovered from the prefix via resByLogical.
    const sdkDeleter = SDK_DELETERS[item.resourceType];
    if (sdkDeleter) {
      const parentLogicalId = item.logicalId.split('/', 1)[0] ?? item.logicalId;
      const parentPhysicalId = resByLogical.get(parentLogicalId)?.physicalId;
      return applyRevertDeleteSdk(
        () => sdkDeleter({ physicalId: item.physicalId, parentPhysicalId, region }),
        buildRetryOpts(item.displayId, deleteDeadlineMs)
      );
    }
    // physicalId IS the CC identifier (the composite the finding carried); delete it.
    return applyRevertDelete(
      cc,
      item,
      item.physicalId,
      buildRetryOpts(item.displayId, deleteDeadlineMs)
    );
  });
  for (const { item, result: r } of deleteOutcomes) {
    if (!r.ok) failedDeleteIds.add(item.logicalId);
    applied.push({
      logicalId: item.logicalId,
      displayId: item.displayId,
      ok: r.ok,
      ...(r.error !== undefined && { error: r.error }),
      ...(r.hint !== undefined && { hint: r.hint }),
    });
    if (!r.ok) worst = Math.max(worst, 2);
    // #952: stream this delete's outcome now if this was its resource's last item.
    streamResultLine(item.logicalId);
  }
  // Collapse per-item results into ONE outcome per resource (a resource that split into a
  // `cc` + `sdk` item produced two results) — used here for the --json tallies AND as a
  // BACKSTOP printer for any resource the streaming path did not already emit.
  // #868: per-resource revert tallies for the --json element (summarize collapses a
  // resource that split into cc + sdk items so it is counted once).
  const summarized = summarizeRevertResults(applied);
  const revertedCount = summarized.filter((s) => s.ok).length;
  const failedCount = summarized.filter((s) => !s.ok).length;
  // #952: every resource whose items all landed was already streamed above the moment it
  // finished, so we must NOT reprint it here (that would double every line). Print only the
  // stragglers — a resource whose item count was never fully reached (should not happen on a
  // normal run; this keeps output complete if it ever does) — mapped back to logicalId via
  // its first applied item.
  for (const item of plan.items) {
    if (streamedLogical.has(item.logicalId)) continue;
    streamResultLine(item.logicalId);
  }

  // Re-check convergence — scoped to the resources the revert just touched (R44).
  // A full gatherFindings here re-read the ENTIRE stack (a long silent wait that
  // scaled with stack size, not with the revert); regatherTouched re-reads only
  // plan.items and carries every other finding forward from the original gather.
  const touched = new Set(plan.items.map((i) => i.logicalId));
  out('\n' + style.note(`verifying convergence (re-reading ${touched.size} resource(s))...`));
  const reconcile = (findings: Finding[]): Finding[] =>
    applyIgnores(
      applyBaseline(findings, baseline, baselineOpts),
      { stackName, accountId: gathered.desired.accountId, region },
      config
    );
  // regatherTouched drops every `touched` finding (including the synthesized-id `added`
  // deletes) and re-reads only template resources — so a FAILED delete's finding is gone
  // from `post` though the resource still lives. Re-add the failed ones so convergence
  // reflects reality (a successful delete stays dropped = resolved).
  const readdFailedDeletes = (findings: Finding[]): Finding[] =>
    failedDeleteIds.size === 0
      ? findings
      : [...findings, ...gathered.findings.filter((f) => failedDeleteIds.has(f.logicalId))];
  let post = readdFailedDeletes(reconcile(await regatherTouched(gathered, touched, region)));
  if (driftCount(post.filter((f) => touched.has(f.logicalId))) > 0) {
    // A touched resource still reads as drifted. SDK-writer paths (IAM etc.) are
    // eventually consistent — the old slow full re-gather granted propagation time
    // for free; the scoped read must wait deliberately. One retry only.
    await sleep(p.convergeRetryDelayMs ?? CONVERGE_RETRY_DELAY_MS);
    post = readdFailedDeletes(reconcile(await regatherTouched(gathered, touched, region)));
  }
  const remainingDrift = post.filter(isDrift);
  const remaining = remainingDrift.length;
  // #631: a `remove`-style revert the provider SILENTLY IGNORED (the #597 class — an
  // omitted property not applied on UpdateResource; Cognito UserPool DeletionProtection,
  // InternetMonitor Status, …) reports `reverted:` (ok) yet the value PERSISTS. When that
  // value is UNRECORDED undeclared it re-reads as "awaiting a baseline" (not `isDrift`), so
  // it escapes both `remaining` and the verdict, and the stack is falsely called CLEAN. A
  // no-op removal = a `remove` op on a SUCCESSFULLY-applied item whose exact path still
  // re-reads a NON-drift finding carrying the SAME value we tried to remove. Comparing the
  // value (not just presence) is essential: a removal that CONVERGED by AWS re-materializing
  // the DEFAULT (#613 SLO Goal) re-reads a DIFFERENT value / tier and is correctly NOT
  // flagged. (Array-element removes, whose finding path is `[id]`-keyed, are not matched here
  // — the reported cases are all top-level/nested scalar paths.)
  const okIds = new Set(applied.filter((a) => a.ok).map((a) => a.logicalId));
  const preActual = new Map<string, unknown>();
  for (const f of gathered.findings) preActual.set(`${f.logicalId}\0${f.path}`, f.actual);
  // #763: an `add`-shaped set-default write (REVERT_SET_DEFAULT_PATHS / KNOWN_DEFAULT_PATHS
  // — the very fix for the remove no-op) can ITSELF be silently ignored by an
  // UpdateUserPool-style omit/ignore provider whose EXPLICIT write is also dropped. Its live
  // value re-reads unchanged, and when the value is UNRECORDED undeclared that re-read is
  // NON-drift (not `isDrift`) → it escapes `remaining`; the item applied ok → not in
  // `failedUpdateIds`; the op is `add` → the remove loop above skipped it → falsely CLEAN.
  // Flag such an add as a no-op when ALL hold: the item applied ok, the post finding at the
  // path is non-drift, the live value did NOT change across the revert (deepEqual pre/post),
  // AND the live value is NOT what the add tried to write (`!deepEqual(post, op.value)` — a
  // successful write that HAPPENED to match op.value is correctly NOT flagged). The
  // declared/recorded cases stay covered by `remaining` (they re-read as drift); this only
  // closes the unrecorded corner.
  const noOpRemovals: { displayId: string; path: string; kind: 'remove' | 'add' }[] = [];
  for (const item of plan.items) {
    if (item.kind === 'delete' || !okIds.has(item.logicalId)) continue;
    for (const op of item.ops) {
      if (op.op !== 'remove' && op.op !== 'add') continue;
      const dotted = op.path.replace(/^\//, '').replace(/\//g, '.');
      const key = `${item.logicalId}\0${dotted}`;
      if (!preActual.has(key)) continue;
      const pre = preActual.get(key);
      const post0 = post.find(
        (f) => f.logicalId === item.logicalId && f.path === dotted && !isDrift(f)
      );
      // Same non-drift persisted-value proof for both op kinds: the pre-revert value is
      // still live after a SUCCESSFUL apply. For `add`, additionally require the live value
      // to NOT equal what we tried to write — else a write that landed (post === op.value)
      // would be mis-flagged.
      const persisted = post0 !== undefined && deepEqual(post0.actual, pre);
      const ignoredWrite =
        op.op === 'remove' ? persisted : persisted && !deepEqual(post0.actual, op.value);
      if (ignoredWrite) noOpRemovals.push({ displayId: item.displayId, path: dotted, kind: op.op });
    }
  }
  // A touched resource whose verification RE-READ failed (skipped tier — a throttle /
  // transient CC or SDK-override read error) is NOT proof the write landed: a write CC
  // accepted (200) but silently rejected, followed by an unreadable re-read, would
  // otherwise count as zero drift and print "CLEAN". Likewise a FAILED delete of an
  // UNRECORDED `added` resource is re-added to `post` but is excluded from `isDrift`
  // (unrecorded), so it too would read as CLEAN though the resource still lives. Treat
  // both as UNCONFIRMED — never claim convergence we could not verify.
  const unverified = post.filter((f) => touched.has(f.logicalId) && f.tier === 'skipped').length;
  const unconfirmed = unverified + failedDeleteIds.size + failedUpdateIds.size;
  const converged = remaining === 0 && unconfirmed === 0 && noOpRemovals.length === 0;
  // Print the no-op removals FIRST so the "did not converge" verdict below has visible
  // evidence above it, mirroring the FAILED: lines' relationship to the unconfirmed count.
  for (const n of noOpRemovals)
    out(
      style.fail(
        n.kind === 'remove'
          ? `  NOT reverted: ${n.displayId}.${n.path} — removal was a no-op (the provider ignored the omitted property; it needs an explicit default write — see #597 / REVERT_SET_DEFAULT_PATHS)`
          : // #763: the explicit default write was itself ignored by an omit/ignore provider.
            `  NOT reverted: ${n.displayId}.${n.path} — the default-value write was a no-op (the provider accepted but ignored it; the out-of-band value persists — see #763 / REVERT_SET_DEFAULT_PATHS)`
      )
    );
  const notConverged = unconfirmed + noOpRemovals.length;
  out(
    converged
      ? style.clean(`${stackName}: CLEAN after revert.`)
      : remaining > 0
        ? style.drift(`${stackName}: ${remaining} drift(s) remain.`)
        : style.drift(
            `${stackName}: revert applied, but ${notConverged} value(s) could not be confirmed converged (see above).`
          )
  );
  // unrecorded values are not drift, but silently dropping them here would read
  // as "all good" when a decision is still pending — one dim pointer line (R62).
  const unrecordedLeft = unrecordedCount(post);
  if (unrecordedLeft > 0)
    out(
      style.note(
        `  (${unrecordedLeft} unrecorded value(s) still await a baseline — run cdkrd record)`
      )
    );
  // A touched resource we could not re-read leaves the revert UNVERIFIED — point the
  // user at a re-run rather than implying success. (A failed delete already printed its
  // own `FAILED:` line above and bumped the exit to 2 in the apply loop.)
  if (unverified > 0)
    out(
      style.note(
        `  (${unverified} resource(s) could not be re-read to verify — re-run cdkrd check to confirm)`
      )
    );
  // Say WHICH drift survived — without this the user must re-run `check` just to
  // learn what didn't converge (R46). A terse id-per-line pointer, not a report;
  // capped so a no-baseline partial revert doesn't re-list 100+ lines (R52).
  for (const line of formatSurvivingDrift(remainingDrift, stackName)) out(line);
  // remaining drift, an unverifiable re-read, OR a no-op removal all mean "not confirmed
  // clean" → exit 1 (a failed delete/update already set 2). Never return 0 ("converged")
  // when we could not verify convergence.
  if (remaining > 0 || unverified > 0 || noOpRemovals.length > 0) worst = Math.max(worst, 1);
  return { exit: worst, aborted: false, reverted: revertedCount, failed: failedCount };
}

/**
 * Map a revert outcome back to `check`'s exit code in the interactive flow (R30).
 * An aborted confirm wrote nothing to AWS, so the drift still stands — keep the
 * pre-revert code (always 1 here, the drift branch); otherwise adopt the outcome's
 * exit (0 clean / 1 drift remains / 2 failure). Pure so the asymmetry is unit-tested.
 */
export function resolveInteractiveRevertExit(currentCode: number, outcome: RevertOutcome): number {
  return outcome.aborted ? currentCode : outcome.exit;
}

// ---- interactive choice (pure, unit-tested) ----

export interface Actions {
  record: boolean; // an undeclared drift exists to record
  ignore: boolean; // a declared or undeclared finding exists to ignore (ignore.yaml)
  revert: boolean; // at least one finding is revertable
}

/**
 * Which interactive actions make sense for a stack's (baseline-reconciled) findings:
 *  - Record when there is undeclared drift OR an out-of-band `added` resource (PR4:
 *    record now snapshots added too — it can't fix declared drift, which is
 *    template-vs-reality, unrelated to the baseline);
 *  - Ignore when there is any declared OR undeclared finding (ignore is symmetric
 *    with revert — it is the only in-tool way to accept a declared drift; R120);
 *  - Revert only when buildRevertPlan yields >=1 revertable item (a stack with only
 *    not-revertable findings, e.g. deleted-only, offers no Revert).
 * Pure: no AWS, no prompts. `schemas` feeds the create-only revert gate.
 */
export function availableActions(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  schemas: Map<string, SchemaInfo>,
  removeUnrecorded: boolean
): Actions {
  const recordable = findings.some((f) => f.tier === 'undeclared' || f.tier === 'added');
  // R141: with NO baseline file yet, `record` is ALWAYS offered — it writes the initial
  // baseline (snapshot-complete resources, plus any undeclared entries) so a fresh deploy can
  // be blessed as the day-1 baseline through `check`'s own prompt (no separate `cdkrd record`
  // step). It is offered EVEN when the only drift is a declared/deleted one it cannot itself
  // resolve: establishing the baseline STARTS undeclared watching, which is orthogonal to that
  // drift — the drift keeps being reported until the user reverts/ignores it. Withholding
  // `record` here used to force the user to clear (or permanently `ignore`) the declared drift
  // before they could even begin watching undeclared state, defeating the tool's core value.
  // `buildResolveOptions` worded the establish option honestly for that case ("the declared
  // drift stays reported"), so it no longer reads as "all done". Once a baseline exists,
  // `record` is offered only when there is undeclared/added state to snapshot.
  const record = recordable || baseline === undefined;
  const ignore = findings.some(
    (f) => f.tier === 'declared' || f.tier === 'undeclared' || f.tier === 'added'
  );
  const plan = buildRevertPlan(findings, baseline, { removeUnrecorded, schemas });
  return { record, ignore, revert: plan.items.length > 0 };
}

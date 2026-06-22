// Per-finding action picker for check's interactive "Decide per finding" path (R121).
//
// The bulk options (Record / Ignore / Revert) apply ONE action to every
// applicable finding. When a stack mixes findings that each deserve a different verb,
// this picker assigns an action PER finding in a single screen:
//   ↑↓ = move · space = cycle the focused row's action · → = set every VISIBLE row to
//   the focused row's action · type = filter rows by label · ⌫ = clear filter · enter = apply
// Type-to-filter (R132): with many findings the target property is hard to spot, so any
// printable character narrows the visible rows to those whose label contains the typed
// text (case-insensitive); the chosen actions on hidden rows are PRESERVED (actions stay
// indexed by ORIGINAL row). → then applies only to the visible (filtered) set, making
// "filter to Tags, → record" a targeted bulk-apply. Movement is arrows-only — j/k are
// freed up as filter input.
// There is deliberately no ← (the bulk-multiselect uses ←/→ for none/all; here → is
// the only bulk key and space cycles, so the two prompts stay key-consistent without
// ← meaning two different things). Each row cycles through only the actions that APPLY
// to its tier, plus `skip` (the default — nothing happens to a skipped finding).
//
// Built on `@clack/core`'s low-level `Prompt` (like bulk-multiselect builds on
// `MultiSelectPrompt`) so it can bind these keys directly. All decision logic is pure
// and unit-tested; the prompt is a thin rendering/key shell.
import { isCancel, Prompt } from '@clack/core';
import { S_BAR, S_BAR_END, S_BAR_START } from '@clack/prompts';
import { isManagedPolicyAttachmentMember, isNestedUndeclared } from '../revert/plan.js';
import type { Finding } from '../types.js';
import { style } from '../report/style.js';

// `skip` is always available (the default); the others are gated by tier.
export type FindingAction = 'record' | 'ignore' | 'revert' | 'skip';

/**
 * The actions that apply to a finding, in cycle order (EXCLUDING the always-present
 * `skip`). Mirrors the verbs' scope:
 *  - undeclared → record (snapshot the norm; gentlest, keeps watching), then ignore
 *    (stop watching), then revert (REMOVE the live value — destructive, so last) —
 *    BUT revert is dropped for a NESTED undeclared value, which is detect/record-only
 *    (R99): offering it would let the user pick an action revert can't run;
 *  - added → record (snapshot the out-of-band resource; keeps watching for changes),
 *    ignore (stop watching), revert (DELETE the resource — destructive, so last). PR4
 *    makes added the resource-level sibling of undeclared, so it takes the same verbs;
 *  - declared → revert (restore the template intent — the natural fix), then ignore;
 *  - everything else (deleted / readGap / unresolved / atDefault / generated / skipped)
 *    has no in-tool action → an empty list, so it is not a decidable row.
 * Pure + exported. `isNestedUndeclared` is the SAME predicate buildRevertPlan uses, so
 * the picker's revert offer and revert's actual capability never diverge.
 */
export function applicableActions(finding: Finding): FindingAction[] {
  if (finding.tier === 'undeclared')
    return isNestedUndeclared(finding) && !isManagedPolicyAttachmentMember(finding)
      ? ['record', 'ignore']
      : ['record', 'ignore', 'revert'];
  if (finding.tier === 'added')
    // A `modelReadFailed` added finding carries only an identity snippet (its full model
    // could not be read this run). buildRecorded DROPS it, so offering `record` is a
    // silent no-op that the closing note still tallies as "1 record" — misleading. Offer
    // only ignore + revert (a delete needs only the identifier), both of which work.
    return finding.modelReadFailed ? ['ignore', 'revert'] : ['record', 'ignore', 'revert'];
  if (finding.tier === 'declared') return ['revert', 'ignore'];
  return [];
}

/** Advance the focused row's action to the next in its ring (`applicable` then `skip`,
 *  wrapping). An action no longer applicable (shouldn't happen) restarts at skip. Pure. */
export function cycleAction(current: FindingAction, applicable: FindingAction[]): FindingAction {
  const ring: FindingAction[] = [...applicable, 'skip'];
  const i = ring.indexOf(current);
  return ring[(i + 1) % ring.length] ?? 'skip';
}

/** Set every VISIBLE row to `action` where that action applies (else `skip`); rows NOT in
 *  `visible` keep their current action. The → key scopes to the current filter, so → after
 *  typing a filter is a targeted bulk-apply over just the matched rows. With `visible` =
 *  every index (no filter) this is the plain "all to focused". Pure + exported. */
export function setVisibleToAction(
  rows: { applicable: FindingAction[] }[],
  actions: FindingAction[],
  visible: number[],
  action: FindingAction
): FindingAction[] {
  const vis = new Set(visible);
  return rows.map((r, i) => {
    if (!vis.has(i)) return actions[i] ?? 'skip';
    return action === 'skip' || r.applicable.includes(action) ? action : 'skip';
  });
}

/** Original-row indices whose label contains `filter` (case-insensitive, trimmed). An empty
 *  filter returns every index. Backs the picker's type-to-filter: the visible set is derived,
 *  so hidden rows never lose their chosen action (actions stay keyed by original index).
 *  Pure + exported. */
export function filterRows(rows: { label: string }[], filter: string): number[] {
  const all = rows.map((_, i) => i);
  const f = filter.trim().toLowerCase();
  if (!f) return all;
  return all.filter((i) => (rows[i]?.label ?? '').toLowerCase().includes(f));
}

const CHIP_WIDTH = 6; // max action label length ('record'/'ignore'/'revert')

/** Center a short string within `width` (extra space biased right). Pure. */
function center(s: string, width: number): string {
  if (s.length >= width) return s;
  const total = width - s.length;
  const left = Math.floor(total / 2);
  return `${' '.repeat(left)}${s}${' '.repeat(total - left)}`;
}

/** The bracketed, fixed-width action chip so the chips form an aligned column:
 *  `[ record ]`, `[ ignore ]`, `[ revert ]`, `[  skip  ]`. Pure + exported. */
export function actionChip(action: FindingAction): string {
  return `[ ${center(action, CHIP_WIDTH)} ]`;
}

/** The dim key-hint line shown under the message. Pure + exported for unit tests.
 *  The action picker only runs inside check's interactive flow, where Esc returns to
 *  the action menu — so `esc = back` (R130). */
export function actionPickerHint(): string {
  return 'type = filter · ↑↓ = move · space = cycle · → = all (filtered) · ⌫ = clear · enter = apply · esc = back';
}

/**
 * Partition items by their chosen action (parallel arrays), dropping `skip`. The
 * dispatch in check.ts routes each group to record / ignore / revert. Pure + exported.
 */
export function groupByAction<T>(
  items: T[],
  actions: FindingAction[]
): { record: T[]; ignore: T[]; revert: T[] } {
  const g: { record: T[]; ignore: T[]; revert: T[] } = { record: [], ignore: [], revert: [] };
  items.forEach((item, i) => {
    const a = actions[i];
    if (a === 'record' || a === 'ignore' || a === 'revert') g[a].push(item);
  });
  return g;
}

/** Tally chosen actions for the one-line submit/summary frame. Pure + exported. */
export function summarizeChoices(actions: FindingAction[]): string {
  const n = (a: FindingAction): number => actions.filter((x) => x === a).length;
  const parts = (['record', 'ignore', 'revert'] as const)
    .filter((a) => n(a) > 0)
    .map((a) => `${n(a)} ${a}`);
  return parts.length > 0 ? parts.join(' · ') : 'nothing selected';
}

/**
 * One rendered row: a focus pointer, the action chip, and the finding label. The
 * focused row is cyan (matches bulk-multiselect's cursor); a non-skip action is shown
 * in its accent (revert is destructive → drift-red), skip is dim. Pure + exported so
 * the "focused row differs + action is legible" invariant is unit-tested. R121.
 */
export function formatActionRow(label: string, action: FindingAction, active: boolean): string {
  const pointer = active ? '❯' : ' ';
  const chip = actionChip(action);
  const cell = `${pointer} ${chip}  ${label}`;
  if (active) return style.cursor(cell);
  if (action === 'skip') return `${pointer} ${style.infoTier(chip)}  ${style.infoTier(label)}`;
  const paint = action === 'revert' ? style.drift : style.ok;
  return `${pointer} ${paint(chip)}  ${label}`;
}

export interface PickerRow {
  label: string;
  applicable: FindingAction[]; // non-empty (decidable rows only); excludes skip
}

/**
 * Assemble the full prompt frame (clack bars + header + rows, or the one-line summary on
 * submit/cancel). Pure + exported so the rendering — the part hardest to exercise through
 * a real TTY — is unit-tested directly. `actionPicker`'s render() is a one-line delegate.
 */
export function renderPickerFrame(
  message: string,
  rows: PickerRow[],
  actions: FindingAction[],
  cursor: number,
  done: boolean,
  filter = '',
  visible?: number[]
): string {
  if (done) return `${S_BAR_START}  ${message}\n${S_BAR}  ${summarizeChoices(actions)}`;
  const vis = visible ?? rows.map((_, i) => i);
  const header = `${S_BAR_START}  ${message}\n${S_BAR}  ${style.infoTier(actionPickerHint())}`;
  // Show the active filter (and a match count) so the narrowing is visible; the row body is
  // the visible subset, with the cursor an index INTO that subset (vi), pointing at the
  // original row visible[vi].
  const filterLine =
    filter.trim().length > 0
      ? `${S_BAR}  ${style.cursor(`filter: ${filter}`)}${style.infoTier(` (${vis.length} match${vis.length === 1 ? '' : 'es'})`)}`
      : undefined;
  const body =
    vis.length === 0
      ? `${S_BAR}  ${style.infoTier(`(no rows match "${filter.trim()}" — ⌫ to clear)`)}`
      : vis
          .map(
            (origIdx, vi) =>
              `${S_BAR}  ${formatActionRow(rows[origIdx]?.label ?? '', actions[origIdx] ?? 'skip', vi === cursor)}`
          )
          .join('\n');
  return [header, filterLine, body, S_BAR_END].filter((l) => l !== undefined).join('\n');
}

/**
 * Show the per-finding picker and return one action per row (parallel to `rows`), or
 * `undefined` on cancel (Ctrl+C / Esc). Every row starts at `skip`, so pressing enter
 * immediately is a safe no-op. `message` is the prompt header; the hint line is
 * appended for you.
 */
export async function actionPicker(
  message: string,
  rows: PickerRow[]
): Promise<FindingAction[] | undefined> {
  const actions: FindingAction[] = rows.map(() => 'skip');
  let cursor = 0; // index INTO the visible subset, not into `rows`
  let filter = '';
  const prompt = new Prompt<FindingAction[]>(
    {
      render() {
        return renderPickerFrame(
          message,
          rows,
          actions,
          cursor,
          this.state === 'submit' || this.state === 'cancel',
          filter,
          filterRows(rows, filter)
        );
      },
    },
    false
  );
  prompt.value = actions;
  prompt.on('key', (char, info) => {
    const name = info?.name;
    const visible = filterRows(rows, filter); // current matched original-row indices
    const focused = visible[cursor]; // the original row the cursor points at (or undefined)
    // Movement is arrows-only — j/k are filter input now. Cursor wraps within the visible set.
    if (name === 'up') {
      if (visible.length > 0) cursor = (cursor - 1 + visible.length) % visible.length;
    } else if (name === 'down') {
      if (visible.length > 0) cursor = (cursor + 1) % visible.length;
    } else if (name === 'space') {
      if (focused !== undefined) {
        actions[focused] = cycleAction(actions[focused] ?? 'skip', rows[focused]?.applicable ?? []);
        prompt.value = [...actions];
      }
    } else if (name === 'right') {
      // bulk-apply the focused action to the VISIBLE (filtered) rows only
      if (focused !== undefined) {
        const next = setVisibleToAction(rows, actions, visible, actions[focused] ?? 'skip');
        for (let i = 0; i < actions.length; i++) actions[i] = next[i] ?? 'skip';
        prompt.value = [...actions];
      }
    } else if (name === 'backspace' || name === 'delete') {
      if (filter.length > 0) {
        filter = filter.slice(0, -1);
        cursor = 0;
      }
    } else if (
      // any other single printable character (not space — that cycles) is filter input
      typeof char === 'string' &&
      char.length === 1 &&
      char >= ' ' &&
      char !== ' ' &&
      !info?.ctrl &&
      !info?.meta
    ) {
      filter += char;
      cursor = 0;
    }
  });
  const result = await prompt.prompt();
  if (isCancel(result)) return undefined;
  return [...actions];
}

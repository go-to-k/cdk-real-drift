// Per-finding action picker for check's interactive "Decide per finding" path (R121).
//
// The bulk options (Record all / Ignore all / Revert all) apply ONE action to every
// applicable finding. When a stack mixes findings that each deserve a different verb,
// this picker assigns an action PER finding in a single screen:
//   ↑↓ = move · space = cycle the focused row's action · → = set every row to the
//   focused row's action · enter = apply
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
import type { Finding } from '../types.js';
import { style } from '../report/style.js';

// `skip` is always available (the default); the others are gated by tier.
export type FindingAction = 'record' | 'ignore' | 'revert' | 'skip';

/**
 * The actions that apply to a finding, in cycle order (EXCLUDING the always-present
 * `skip`). Mirrors the verbs' scope:
 *  - undeclared → record (snapshot the norm; gentlest, keeps watching), then ignore
 *    (stop watching), then revert (REMOVE the live value — destructive, so last);
 *  - declared → revert (restore the template intent — the natural fix), then ignore;
 *  - everything else (deleted / readGap / unresolved / atDefault / generated / skipped)
 *    has no in-tool action → an empty list, so it is not a decidable row.
 * Pure + exported.
 */
export function applicableActions(finding: Finding): FindingAction[] {
  if (finding.tier === 'undeclared') return ['record', 'ignore', 'revert'];
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

/** Set every row to `action` where that action applies to the row, else `skip`
 *  (the → "all to focused" bulk key). Pure + exported. */
export function setAllToAction(
  rows: { applicable: FindingAction[] }[],
  action: FindingAction
): FindingAction[] {
  return rows.map((r) => (action === 'skip' || r.applicable.includes(action) ? action : 'skip'));
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

/** The dim key-hint line shown under the message. Pure + exported for unit tests. */
export function actionPickerHint(): string {
  return '↑↓ = move · space = cycle · → = all to focused · enter = apply';
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
  done: boolean
): string {
  if (done) return `${S_BAR_START}  ${message}\n${S_BAR}  ${summarizeChoices(actions)}`;
  const header = `${S_BAR_START}  ${message}\n${S_BAR}  ${style.infoTier(actionPickerHint())}`;
  const body = rows
    .map((row, i) => `${S_BAR}  ${formatActionRow(row.label, actions[i] ?? 'skip', i === cursor)}`)
    .join('\n');
  return `${header}\n${body}\n${S_BAR_END}`;
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
  let cursor = 0;
  const prompt = new Prompt<FindingAction[]>(
    {
      render() {
        return renderPickerFrame(
          message,
          rows,
          actions,
          cursor,
          this.state === 'submit' || this.state === 'cancel'
        );
      },
    },
    false
  );
  prompt.value = actions;
  prompt.on('key', (_char, info) => {
    const name = info?.name;
    if (name === 'up' || name === 'k') cursor = (cursor - 1 + rows.length) % rows.length;
    else if (name === 'down' || name === 'j') cursor = (cursor + 1) % rows.length;
    else if (name === 'space') {
      actions[cursor] = cycleAction(actions[cursor] ?? 'skip', rows[cursor]?.applicable ?? []);
      prompt.value = [...actions];
    } else if (name === 'right') {
      const target = actions[cursor] ?? 'skip';
      const next = setAllToAction(rows, target);
      for (let i = 0; i < actions.length; i++) actions[i] = next[i] ?? 'skip';
      prompt.value = [...actions];
    }
  });
  const result = await prompt.prompt();
  if (isCancel(result)) return undefined;
  return [...actions];
}

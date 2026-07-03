// Interactive multi-select with BULK keys, shared by record + revert (R116).
//
// The high-level `@clack/prompts` multiselect only exposes `a` (toggle all) / `i`
// (invert) for bulk selection, hidden behind a dim hint and easy to miss. Mirroring
// `cdk-local`'s target picker, this builds on `@clack/core`'s low-level
// `MultiSelectPrompt` so it can bind the keys users reach for first:
//   space = toggle the cursor row · → = select all · ← = clear all · enter = confirm
// `MultiSelectPrompt` ALSO maps Left/Right onto the cursor (as Up/Down) and that fires
// before our handler, so after a bulk change we pin the cursor to the top for a stable
// position. Selection lives in `this.value`, so the handlers set it directly — the same
// mechanism the built-in `toggleAll` uses.
import { MultiSelectPrompt } from '@clack/core';
import {
  isCancel,
  S_BAR,
  S_BAR_END,
  S_BAR_START,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
} from '@clack/prompts';
import { style } from '../report/style.js';

export interface BulkOption {
  value: string;
  label: string;
  selected: boolean; // initial selection state (RESTORE pre-selected, REMOVE not, etc.)
}

/** The selected-value array after a bulk action — `all` selects every option, `none`
 *  clears it. Pure (no prompt state) so the →/← wiring is unit-testable without a TTY. */
export function bulkSelectValues(options: { value: string }[], action: 'all' | 'none'): string[] {
  return action === 'all' ? options.map((o) => o.value) : [];
}

/** The key-hint line shown under the message (readable — style.note, not dim: it is
 *  meant to be read). Pure + exported for unit tests.
 *  `esc = cancel` is listed last (R130): Esc aborts the prompt — in check's interactive
 *  flow that returns to the action menu, in a standalone `record`/`ignore` it cancels
 *  the command; either way the selection is discarded, so `cancel` is accurate in both. */
export function bulkSelectHint(): string {
  return 'space = toggle · → = all · ← = none · enter = confirm · esc = cancel';
}

type Opt = { value: string; label: string };

/**
 * One rendered row. The cursor row MUST be visually distinct or up/down navigation
 * looks dead (R116 regression: `S_CHECKBOX_ACTIVE` and `S_CHECKBOX_INACTIVE` are the
 * SAME glyph in clack — only colour told them apart — and a selected row always showed
 * the filled box regardless of focus, so the cursor was invisible). A leading `❯`
 * pointer marks the focused row even with NO_COLOR; with colour it is also cyan. Pure +
 * exported so the "focused row differs from the rest" invariant is unit-tested. R118.
 */
export function formatRow(label: string, state: { active: boolean; selected: boolean }): string {
  const pointer = state.active ? '❯' : ' ';
  const box = state.selected ? S_CHECKBOX_SELECTED : S_CHECKBOX_INACTIVE;
  const cell = `${pointer} ${box} ${label}`;
  if (state.active) return style.cursor(cell);
  return state.selected ? `${pointer} ${style.ok(box)} ${style.ok(label)}` : cell;
}

/**
 * Show the multi-select and return the picked values, or `undefined` on cancel
 * (Ctrl+C / Esc). `message` is the prompt header; the hint line is appended for you.
 */
export async function bulkMultiselect(
  message: string,
  options: BulkOption[]
): Promise<string[] | undefined> {
  const prompt = new MultiSelectPrompt<Opt>({
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValues: options.filter((o) => o.selected).map((o) => o.value),
    required: false,
    render() {
      if (this.state === 'submit' || this.state === 'cancel') {
        return `${S_BAR_START}  ${message}\n${S_BAR}  ${(this.value ?? []).length} selected`;
      }
      const header = `${S_BAR_START}  ${message}\n${S_BAR}  ${style.note(bulkSelectHint())}`;
      const selected = new Set(this.value ?? []);
      const rows = this.options.map(
        (opt, i) =>
          `${S_BAR}  ${formatRow(opt.label, { active: i === this.cursor, selected: selected.has(opt.value) })}`
      );
      return `${header}\n${rows.join('\n')}\n${S_BAR_END}`;
    },
  });
  prompt.on('key', (_char, info) => {
    if (info?.name !== 'right' && info?.name !== 'left') return;
    prompt.value = bulkSelectValues(options, info.name === 'right' ? 'all' : 'none');
    prompt.cursor = 0;
  });
  const picked = await prompt.prompt();
  if (isCancel(picked)) return undefined;
  return (picked as string[] | undefined) ?? [];
}

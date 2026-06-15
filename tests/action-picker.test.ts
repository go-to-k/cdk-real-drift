import { describe, expect, it } from 'vite-plus/test';
import {
  actionChip,
  actionPickerHint,
  applicableActions,
  cycleAction,
  type FindingAction,
  formatActionRow,
  groupByAction,
  type PickerRow,
  renderPickerFrame,
  setAllToAction,
  summarizeChoices,
} from '../src/commands/action-picker.js';
import type { Finding } from '../src/types.js';

const F = (tier: Finding['tier']): Finding => ({
  tier,
  logicalId: 'L',
  resourceType: 'AWS::S3::Bucket',
  path: 'P',
});

describe('applicableActions (cycle order mirrors the verbs scope)', () => {
  it('undeclared (top-level) → record, ignore, revert (destructive revert last)', () => {
    expect(applicableActions(F('undeclared'))).toEqual(['record', 'ignore', 'revert']);
  });
  it('NESTED undeclared drops revert — it is detect/record-only (R99)', () => {
    // dotted, bracketed, or flagged-nested undeclared → no revert offered (revert can't
    // build a safe RFC6902 patch for a nested path), matching buildRevertPlan.
    expect(applicableActions({ ...F('undeclared'), path: 'Origins.0.Timeout' })).toEqual([
      'record',
      'ignore',
    ]);
    expect(applicableActions({ ...F('undeclared'), path: 'Origins[o1].Timeout' })).toEqual([
      'record',
      'ignore',
    ]);
    expect(applicableActions({ ...F('undeclared'), path: 'P', nested: true })).toEqual([
      'record',
      'ignore',
    ]);
  });
  it('declared → revert (the natural fix), ignore — never record', () => {
    expect(applicableActions(F('declared'))).toEqual(['revert', 'ignore']);
  });
  it('non-actionable tiers → empty (not decidable rows)', () => {
    for (const t of [
      'deleted',
      'readGap',
      'unresolved',
      'atDefault',
      'generated',
      'skipped',
    ] as const)
      expect(applicableActions(F(t))).toEqual([]);
  });
});

describe('cycleAction', () => {
  const applicable: FindingAction[] = ['record', 'ignore', 'revert'];
  it('walks applicable then skip, wrapping back to the first', () => {
    expect(cycleAction('skip', applicable)).toBe('record');
    expect(cycleAction('record', applicable)).toBe('ignore');
    expect(cycleAction('ignore', applicable)).toBe('revert');
    expect(cycleAction('revert', applicable)).toBe('skip');
  });
  it('a single-applicable ring toggles action <-> skip', () => {
    expect(cycleAction('skip', ['ignore'])).toBe('ignore');
    expect(cycleAction('ignore', ['ignore'])).toBe('skip');
  });
});

describe('setAllToAction (the → bulk key)', () => {
  const rows = [
    { applicable: ['record', 'ignore', 'revert'] as FindingAction[] }, // undeclared
    { applicable: ['revert', 'ignore'] as FindingAction[] }, // declared
  ];
  it('sets every row that supports the action, skips the rest', () => {
    // 'record' applies only to the undeclared row → declared row falls back to skip
    expect(setAllToAction(rows, 'record')).toEqual(['record', 'skip']);
    // 'ignore' applies to both
    expect(setAllToAction(rows, 'ignore')).toEqual(['ignore', 'ignore']);
    // 'revert' applies to both
    expect(setAllToAction(rows, 'revert')).toEqual(['revert', 'revert']);
  });
  it('skip sets every row to skip', () => {
    expect(setAllToAction(rows, 'skip')).toEqual(['skip', 'skip']);
  });
});

describe('actionChip (fixed-width, aligned column)', () => {
  it('all chips are the same width so the column aligns', () => {
    const widths = (['record', 'ignore', 'revert', 'skip'] as const).map(
      (a) => actionChip(a).length
    );
    expect(new Set(widths).size).toBe(1);
  });
  it('contains the action name', () => {
    expect(actionChip('record')).toContain('record');
    expect(actionChip('skip')).toContain('skip');
  });
});

describe('summarizeChoices', () => {
  it('tallies non-skip actions, ignoring skips', () => {
    expect(summarizeChoices(['record', 'record', 'skip', 'ignore'])).toBe('2 record · 1 ignore');
  });
  it('all skip → nothing selected', () => {
    expect(summarizeChoices(['skip', 'skip'])).toBe('nothing selected');
  });
});

describe('actionPickerHint', () => {
  it('names the keys (move / cycle / all / apply)', () => {
    const h = actionPickerHint();
    expect(h).toContain('space');
    expect(h).toContain('→');
    expect(h).toContain('enter');
    expect(h).toContain('esc'); // R130: Esc returns to the action menu
  });
});

describe('formatActionRow (focused row must be visually distinct)', () => {
  it('active row carries the ❯ pointer; inactive does not', () => {
    expect(formatActionRow('L.P', 'record', true)).toContain('❯');
    expect(formatActionRow('L.P', 'record', false)).not.toContain('❯');
  });
  it('active differs from inactive for the same action', () => {
    expect(formatActionRow('L.P', 'ignore', true)).not.toBe(
      formatActionRow('L.P', 'ignore', false)
    );
  });
  it('always shows the label and the chosen action', () => {
    const row = formatActionRow('MyStack/Bucket.Versioning', 'revert', false);
    expect(row).toContain('MyStack/Bucket.Versioning');
    expect(row).toContain('revert');
  });
});

describe('renderPickerFrame (the prompt frame — render logic exercised without a TTY)', () => {
  const rows: PickerRow[] = [
    { label: 'A.x', applicable: ['record', 'ignore', 'revert'] },
    { label: 'B.y', applicable: ['revert', 'ignore'] },
  ];

  it('active frame shows the message, hint, one line per row, and marks the cursor row', () => {
    const frame = renderPickerFrame('pick:', rows, ['record', 'skip'], 0, false);
    expect(frame).toContain('pick:');
    expect(frame).toContain('space'); // the hint
    expect(frame).toContain('A.x');
    expect(frame).toContain('B.y');
    // exactly one ❯ pointer (the focused row)
    expect(frame.split('❯').length - 1).toBe(1);
  });

  it('moving the cursor moves the pointer (row 1 focused now)', () => {
    const f0 = renderPickerFrame('m', rows, ['skip', 'skip'], 0, false);
    const f1 = renderPickerFrame('m', rows, ['skip', 'skip'], 1, false);
    expect(f0).not.toBe(f1); // the focused row changed
    expect(f1.split('❯').length - 1).toBe(1);
  });

  it('the done frame collapses to the one-line summary (no rows)', () => {
    const frame = renderPickerFrame('pick:', rows, ['record', 'ignore'], 0, true);
    expect(frame).toContain('1 record · 1 ignore');
    expect(frame).not.toContain('A.x');
  });
});

describe('groupByAction', () => {
  it('partitions items by action, dropping skip', () => {
    const items = ['a', 'b', 'c', 'd'];
    const actions: FindingAction[] = ['record', 'ignore', 'skip', 'revert'];
    expect(groupByAction(items, actions)).toEqual({ record: ['a'], ignore: ['b'], revert: ['d'] });
  });
  it('all skip → empty groups', () => {
    expect(groupByAction(['a', 'b'], ['skip', 'skip'])).toEqual({
      record: [],
      ignore: [],
      revert: [],
    });
  });
});

import { describe, expect, it } from 'vite-plus/test';
import {
  actionChip,
  actionPickerHint,
  applicableActions,
  cycleAction,
  type FindingAction,
  formatActionRow,
  groupByAction,
  filterRows,
  type PickerRow,
  renderPickerFrame,
  setVisibleToAction,
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
  it('PR4: added → record (snapshot), ignore, revert (DELETE — destructive, last)', () => {
    expect(applicableActions(F('added'))).toEqual(['record', 'ignore', 'revert']);
  });
  it('a modelReadFailed added drops record (it would be a silent no-op) → ignore, revert only', () => {
    expect(applicableActions({ ...F('added'), modelReadFailed: true })).toEqual([
      'ignore',
      'revert',
    ]);
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

describe('setVisibleToAction (the → bulk key, scoped to the visible/filtered set)', () => {
  const rows = [
    { applicable: ['record', 'ignore', 'revert'] as FindingAction[] }, // undeclared
    { applicable: ['revert', 'ignore'] as FindingAction[] }, // declared
  ];
  const ALL = [0, 1];
  const start: FindingAction[] = ['skip', 'skip'];
  it('with every index visible, sets every row that supports the action, skips the rest', () => {
    // 'record' applies only to the undeclared row → declared row falls back to skip
    expect(setVisibleToAction(rows, start, ALL, 'record')).toEqual(['record', 'skip']);
    expect(setVisibleToAction(rows, start, ALL, 'ignore')).toEqual(['ignore', 'ignore']);
    expect(setVisibleToAction(rows, start, ALL, 'revert')).toEqual(['revert', 'revert']);
  });
  it('skip sets every visible row to skip', () => {
    expect(setVisibleToAction(rows, ['record', 'revert'], ALL, 'skip')).toEqual(['skip', 'skip']);
  });
  it('rows NOT in the visible set keep their current action (filtered bulk-apply)', () => {
    // only row 0 visible → row 1 retains its prior 'revert'
    expect(setVisibleToAction(rows, ['skip', 'revert'], [0], 'ignore')).toEqual([
      'ignore',
      'revert',
    ]);
    // only row 1 visible, 'record' doesn't apply there → row 1 becomes skip, row 0 untouched
    expect(setVisibleToAction(rows, ['record', 'ignore'], [1], 'record')).toEqual([
      'record',
      'skip',
    ]);
  });
});

describe('filterRows (type-to-filter visible set)', () => {
  const rows: PickerRow[] = [
    { label: 'Api/Bucket.Tags', applicable: ['record'] },
    { label: 'Api/Queue.Tags', applicable: ['record'] },
    { label: 'Api/Role.PermissionsBoundary', applicable: ['revert'] },
  ];
  it('empty (or whitespace) filter returns every index', () => {
    expect(filterRows(rows, '')).toEqual([0, 1, 2]);
    expect(filterRows(rows, '   ')).toEqual([0, 1, 2]);
  });
  it('matches the label case-insensitively, returning ORIGINAL indices', () => {
    expect(filterRows(rows, 'tags')).toEqual([0, 1]);
    expect(filterRows(rows, 'TAGS')).toEqual([0, 1]);
    expect(filterRows(rows, 'role')).toEqual([2]);
    expect(filterRows(rows, 'bucket')).toEqual([0]);
  });
  it('no match returns an empty list', () => {
    expect(filterRows(rows, 'zzz')).toEqual([]);
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
  it('names the keys (filter / move / cycle / all / apply)', () => {
    const h = actionPickerHint();
    expect(h).toContain('filter'); // R132: type-to-filter
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

  it('with a filter, shows the filter line + only the visible rows; cursor indexes the subset', () => {
    // filter matches only row 1 (B.y); visible=[1], cursor=0 points at the original row 1
    const frame = renderPickerFrame('m', rows, ['skip', 'revert'], 0, false, 'b.y', [1]);
    expect(frame).toContain('filter: b.y');
    expect(frame).toContain('1 match'); // match count, singular
    expect(frame).toContain('B.y');
    expect(frame).not.toContain('A.x'); // filtered out
    expect(frame.split('❯').length - 1).toBe(1); // the single visible row is focused
  });

  it('a filter with no matches shows a no-rows hint and no row pointer', () => {
    const frame = renderPickerFrame('m', rows, ['skip', 'skip'], 0, false, 'zzz', []);
    expect(frame).toContain('no rows match');
    expect(frame).not.toContain('A.x');
    expect(frame).not.toContain('B.y');
    expect(frame.split('❯').length - 1).toBe(0);
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

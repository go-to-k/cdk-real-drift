import { describe, expect, it } from 'vite-plus/test';
import { bulkSelectHint, bulkSelectValues, formatRow } from '../src/commands/bulk-multiselect.js';

describe('bulkSelectValues (→ = all, ← = none)', () => {
  const opts = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];

  it('"all" returns every option value (→ selects all)', () => {
    expect(bulkSelectValues(opts, 'all')).toEqual(['a', 'b', 'c']);
  });

  it('"none" returns an empty selection (← clears all)', () => {
    expect(bulkSelectValues(opts, 'none')).toEqual([]);
  });

  it('"none" on an empty option list is still empty (no crash)', () => {
    expect(bulkSelectValues([], 'none')).toEqual([]);
    expect(bulkSelectValues([], 'all')).toEqual([]);
  });
});

describe('formatRow (R118 — the focused row MUST be visually distinct, color or not)', () => {
  it('the active row carries the ❯ pointer; inactive rows do not (NO_COLOR-safe cursor)', () => {
    const active = formatRow('Foo', { active: true, selected: false });
    const inactive = formatRow('Foo', { active: false, selected: false });
    expect(active).toContain('❯');
    expect(inactive).not.toContain('❯');
    expect(active).not.toBe(inactive); // moving the cursor visibly changes a row
  });

  it('a selected row differs from an unselected one at the same focus (box state shows)', () => {
    // assert they DIFFER rather than the exact glyph — clack downgrades the box to an
    // ASCII fallback when the terminal lacks unicode, so the codepoint is not stable.
    expect(formatRow('Foo', { active: false, selected: true })).not.toBe(
      formatRow('Foo', { active: false, selected: false })
    );
  });

  it('the focused row differs whether or not it is selected (cursor never hidden)', () => {
    expect(formatRow('Foo', { active: true, selected: true })).toContain('❯');
    expect(formatRow('Foo', { active: true, selected: true })).not.toBe(
      formatRow('Foo', { active: false, selected: true })
    );
  });
});

describe('bulkSelectHint', () => {
  it('names space toggle, → all, ← none, enter confirm (and NOT the old a/i keys)', () => {
    const h = bulkSelectHint();
    expect(h).toContain('space');
    expect(h).toContain('→');
    expect(h).toContain('←');
    expect(h).toContain('enter');
    expect(h).not.toContain('toggle all'); // the discoverable-but-cryptic `a`/`i` are gone
  });
});

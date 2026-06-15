import { describe, expect, it } from 'vite-plus/test';
import { bulkSelectHint, bulkSelectValues } from '../src/commands/bulk-multiselect.js';

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

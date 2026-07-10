import { describe, expect, it } from 'vite-plus/test';
import { baselineValueMatches } from '../src/baseline/baseline-file.js';
import { sortUnorderedObjectArray } from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';

// #767: `baselineValueMatches` must be REFLEXIVE for identity-keyed / object-array
// values too. `canonicalizeForCompare` only IDENTITY-sorts object arrays (Key/Id/
// Name/…), but the live model reaches a DIFFERENT total order — classify's
// `sortUnorderedSetProps` runs a full CANONICAL-JSON `sortUnorderedObjectArray` over
// unordered object-array props. For an array whose elements share NO identity field
// the identity-sort is a no-op, so the live `f.actual` lands in canonical-JSON order
// while the recorded raw baseline stays in template order — `deepEqual` is positional,
// so the two never converge and `record` -> `check` is a permanent "changed since
// record" that re-recording can't clear. The fix re-applies the SAME canonical-JSON
// sort (deeply) to BOTH sides so they converge on one order.
describe('#767 baselineValueMatches reflexivity for reordered object arrays', () => {
  // The exact shape from the issue: identity-keyed (`Name`) elements whose
  // identity-sort order differs from their canonical-JSON order.
  it('(reflexive) identity-keyed array where identity order != canonical-JSON order', () => {
    const v = [
      { A: 1, Name: 'n2' },
      { Name: 'n1', Z: 2 },
    ];
    expect(baselineValueMatches(v, v)).toBe(true);
  });

  // The residual #767 case #807 did NOT cover: an IDENTITY-LESS object array. Here
  // `canonicalizeForCompare`'s identity-sort is a no-op, so only the deep
  // canonical-JSON sort makes a live-reordered array converge with the raw baseline.
  it('(reflexive) identity-less object array (raw baseline vs canon-JSON-reordered live)', () => {
    const raw = [{ Zeta: 1 }, { Alpha: 2 }];
    // Emulate the live model's ordering (classify's sortUnorderedObjectArray).
    const live = sortUnorderedObjectArray(canonicalizeForCompare(raw));
    // The live model reordered the array relative to the raw template order...
    expect(JSON.stringify(live)).not.toBe(JSON.stringify(canonicalizeForCompare(raw)));
    // ...yet the recorded raw baseline still matches it.
    expect(baselineValueMatches(raw, live)).toBe(true);
    // And it is reflexive with itself.
    expect(baselineValueMatches(raw, raw)).toBe(true);
  });

  it('(reflexive) nested object array inside an object still converges', () => {
    const rules = [
      { Effect: 'Deny', SortKey: 'z' },
      { SortKey: 'a', Effect: 'Allow' },
    ];
    const v = { Rules: rules };
    // Emulate the live model reordering the nested array (classify sorts it in place).
    const live = { Rules: sortUnorderedObjectArray(canonicalizeForCompare(rules)) };
    expect(baselineValueMatches(v, v)).toBe(true);
    expect(baselineValueMatches(v, live)).toBe(true);
  });

  it('(reflexive) deeply nested object array (array of objects holding arrays)', () => {
    const v = [
      { Group: 'g2', Items: [{ B: 2 }, { A: 1 }] },
      { Group: 'g1', Items: [{ D: 4 }, { C: 3 }] },
    ];
    expect(baselineValueMatches(v, v)).toBe(true);
  });

  // NEGATIVE guard: the symmetric sort only REORDERS — it must NOT loosen the
  // predicate into matching genuinely-different values.
  it('(negative) a changed element value still returns false', () => {
    const recorded = [{ Zeta: 1 }, { Alpha: 2 }];
    const changed = [{ Zeta: 1 }, { Alpha: 999 }];
    expect(baselineValueMatches(recorded, changed)).toBe(false);
  });

  it('(negative) a changed identity-keyed element still returns false', () => {
    const recorded = [
      { Name: 'n1', Value: 'a' },
      { Name: 'n2', Value: 'b' },
    ];
    const changed = [
      { Name: 'n1', Value: 'a' },
      { Name: 'n2', Value: 'CHANGED' },
    ];
    expect(baselineValueMatches(recorded, changed)).toBe(false);
  });

  it('(negative) an added element still returns false', () => {
    const recorded = [{ Zeta: 1 }, { Alpha: 2 }];
    const changed = [{ Zeta: 1 }, { Alpha: 2 }, { Extra: 3 }];
    expect(baselineValueMatches(recorded, changed)).toBe(false);
  });
});

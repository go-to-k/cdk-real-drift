import { describe, expect, it } from 'vite-plus/test';
import { matchesKnownDefault } from '../src/diff/classify.js';
import { isEqualUnorderedScalarSet } from '../src/normalize/noise.js';

// Issue #731: two equality gates adjacent to the globally numeric-string-tolerant
// declared comparator were NOT tolerant of scalar REPRESENTATION, leaving latent
// first-run-FP windows when a provider stringifies a scalar (Budgets `"5.0"` for 5,
// CodePipeline `"false"` for false, SQS `"5"` for 5). Both now fold semantically-equal
// numeric-string forms while keeping genuinely-different values distinct.
describe('isEqualUnorderedScalarSet stringly tolerance (#731)', () => {
  it('folds a set that both REORDERS and STRINGIFIES', () => {
    // declared [80, 443] vs live ["443", "80"] — order differs AND types differ.
    expect(isEqualUnorderedScalarSet([80, 443], ['443', '80'])).toBe(true);
  });

  it('preserves detection when a value genuinely differs', () => {
    expect(isEqualUnorderedScalarSet([80, 443], ['443', '81'])).toBe(false);
  });

  it('still folds non-numeric reordered sets', () => {
    expect(isEqualUnorderedScalarSet(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('folds a mixed numeric/non-numeric set that stringifies the number', () => {
    expect(isEqualUnorderedScalarSet(['a', 80], ['80', 'a'])).toBe(true);
  });

  it('keeps distinct numeric strings distinct', () => {
    expect(isEqualUnorderedScalarSet(['80'], ['81'])).toBe(false);
  });

  it('folds decimal-string representation variants (5 vs "5.0")', () => {
    expect(isEqualUnorderedScalarSet([5], ['5.0'])).toBe(true);
  });

  it('does not fold non-numeric string vs number', () => {
    expect(isEqualUnorderedScalarSet(['abc'], [80])).toBe(false);
  });
});

describe('matchesKnownDefault stringly tolerance (#731)', () => {
  it('folds a pinned scalar default 1 against a live "1"', () => {
    expect(matchesKnownDefault('1', 1)).toBe(true);
  });

  it('preserves detection: default 1 vs live "2"', () => {
    expect(matchesKnownDefault('2', 1)).toBe(false);
  });

  it('does NOT fold boolean<->string (a schema default "true" must not hide a live boolean true)', () => {
    // #731: numeric-only tolerance. The S3 schema default `EventBridgeEnabled` is the STRING
    // "true"; folding it against a live BOOLEAN true would hide a real user-enabled config.
    expect(matchesKnownDefault('false', false)).toBe(false);
    expect(matchesKnownDefault(true, 'true')).toBe(false);
  });

  it('folds a decimal-string live "5.0" against a numeric default 5', () => {
    expect(matchesKnownDefault('5.0', 5)).toBe(true);
  });

  it('folds a nested object default with a numeric leaf against a stringified live leaf', () => {
    expect(
      matchesKnownDefault(
        { RetentionDays: '1', Enabled: true },
        { RetentionDays: 1, Enabled: true }
      )
    ).toBe(true);
  });

  it('still surfaces a genuinely different nested value', () => {
    expect(
      matchesKnownDefault(
        { RetentionDays: '2', Enabled: true },
        { RetentionDays: 1, Enabled: true }
      )
    ).toBe(false);
  });

  it('keeps the object subset tolerance intact (live omits a default key)', () => {
    // live carries only a subset of the default's keys — must still fold.
    expect(
      matchesKnownDefault({ Types: ['EDGE'] }, { IpAddressType: 'ipv4', Types: ['EDGE'] })
    ).toBe(true);
  });
});

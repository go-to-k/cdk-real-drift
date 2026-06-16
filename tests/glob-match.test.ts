import { describe, expect, it } from 'vite-plus/test';
import { globToRegExp, isGlob, matchesGlob, matchesPathGlob } from '../src/commands/glob-match.js';

describe('isGlob', () => {
  it('detects * and ?', () => {
    expect(isGlob('Dev*')).toBe(true);
    expect(isGlob('*Api')).toBe(true);
    expect(isGlob('Stack?')).toBe(true);
    expect(isGlob('a?b*c')).toBe(true);
  });

  it('is false for plain names', () => {
    expect(isGlob('DevStack')).toBe(false);
    expect(isGlob('Prod-Api-123')).toBe(false);
    expect(isGlob('')).toBe(false);
  });
});

describe('matchesGlob', () => {
  it('* matches any run (including empty)', () => {
    expect(matchesGlob('Dev*', 'DevApi')).toBe(true);
    expect(matchesGlob('Dev*', 'Dev')).toBe(true);
    expect(matchesGlob('Dev*', 'DevStackOne')).toBe(true);
    expect(matchesGlob('*Api', 'DevApi')).toBe(true);
    expect(matchesGlob('*Api', 'Api')).toBe(true);
    expect(matchesGlob('*', 'Anything')).toBe(true);
    expect(matchesGlob('Dev*Stack', 'DevFooStack')).toBe(true);
  });

  it('* does not match a different prefix/suffix', () => {
    expect(matchesGlob('Dev*', 'ProdApi')).toBe(false);
    expect(matchesGlob('*Api', 'ApiGateway')).toBe(false);
  });

  it('? matches exactly one char', () => {
    expect(matchesGlob('Stack?', 'StackA')).toBe(true);
    expect(matchesGlob('Stack?', 'Stack1')).toBe(true);
    expect(matchesGlob('Stack?', 'Stack')).toBe(false); // needs one char
    expect(matchesGlob('Stack?', 'StackAB')).toBe(false); // exactly one
    expect(matchesGlob('a?c', 'abc')).toBe(true);
    expect(matchesGlob('a?c', 'ac')).toBe(false);
  });

  it('is anchored — no partial match', () => {
    expect(matchesGlob('Api', 'DevApiStack')).toBe(false);
    expect(matchesGlob('Api', 'Api')).toBe(true);
    expect(matchesGlob('Dev', 'DevStack')).toBe(false);
  });

  it('escapes regex metachars (treats them as literals)', () => {
    // `.` is literal, not "any char"
    expect(matchesGlob('Dev.Stack', 'DevXStack')).toBe(false);
    expect(matchesGlob('Dev.Stack', 'Dev.Stack')).toBe(true);
    // other metachars: +, (, ), |, [, ]
    expect(matchesGlob('a+b', 'a+b')).toBe(true);
    expect(matchesGlob('a+b', 'aaab')).toBe(false);
    expect(matchesGlob('(x)', '(x)')).toBe(true);
    expect(matchesGlob('a|b', 'a|b')).toBe(true);
    expect(matchesGlob('a|b', 'a')).toBe(false);
    expect(matchesGlob('a[b]', 'a[b]')).toBe(true);
    // combined: literal dot with a glob star
    expect(matchesGlob('*.Api', 'Dev.Api')).toBe(true);
    expect(matchesGlob('*.Api', 'DevXApi')).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('produces an anchored RegExp', () => {
    const re = globToRegExp('Dev*');
    expect(re.source).toBe('^Dev.*$');
    expect(re.test('DevApi')).toBe(true);
    expect(re.test('XDevApi')).toBe(false);
  });

  it('escapes dot to a literal', () => {
    expect(globToRegExp('a.b').source).toBe('^a\\.b$');
  });

  it('collapses a run of consecutive `*` to a single `.*` (ReDoS-safe, same semantics)', () => {
    // `*****` is semantically identical to `*`; without the collapse it compiles to
    // `.*.*.*.*.*` which backtracks catastrophically on a long non-matching subject.
    // The `^.*X$` source (one `.*`, not five) IS the fix — it cannot backtrack-partition.
    expect(globToRegExp('*****X').source).toBe('^.*X$');
    expect(globToRegExp('a***b').source).toBe('^a.*b$');
    // semantics preserved
    expect(matchesGlob('*****X', 'aaaaaX')).toBe(true);
    expect(matchesGlob('*****X', 'aaaaaY')).toBe(false);
    // a long non-match returns promptly (no catastrophic backtracking)
    expect(matchesGlob('**********X', 'a'.repeat(60))).toBe(false);
  });
});

describe('matchesPathGlob (segment-aware — does not cross . or [ boundaries)', () => {
  it('* / ? stay within one dot/bracket segment', () => {
    expect(matchesPathGlob('*.DesiredCount', 'Svc123.DesiredCount')).toBe(true); // id wildcard
    expect(matchesPathGlob('*.DesiredCount', 'Tbl.Config.DesiredCount')).toBe(false); // no cross-dot
    expect(matchesPathGlob('Fn*.Mem', 'FnABC.Mem')).toBe(true);
    expect(matchesPathGlob('Fn*.Mem', 'FnA.Sub.Mem')).toBe(false);
    expect(matchesPathGlob('*', 'BareId')).toBe(true);
    expect(matchesPathGlob('*', 'A.B')).toBe(false); // bare star is one segment (subtree via ancestor walk)
    expect(matchesPathGlob('Tags[*]', 'Tags[env]')).toBe(true); // within a bracket key
    expect(matchesPathGlob('Tags[*]', 'Tags[env].Sub')).toBe(false);
  });

  it('still collapses *+ runs (no catastrophic backtracking)', () => {
    expect(matchesPathGlob('****X', 'aaaaaX')).toBe(true);
    expect(matchesPathGlob('**********X', 'a'.repeat(60))).toBe(false);
  });
});

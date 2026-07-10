import { basename } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { baselinePath, sanitizeStackNameComponent } from '../src/baseline/baseline-file.js';

// #1077: a stack named exactly a Windows reserved DOS device name (`nul`, `con`, `aux`,
// `prn`, `com1`-`com9`, `lpt1`-`lpt9` — all valid CloudFormation stack names) must NOT map
// its baseline filename to a Win32 device. The base name (before the FIRST dot,
// case-insensitively) must never equal a reserved device after sanitization.

const RESERVED = [
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
];

// The Win32 rule: the base name is the substring before the first dot, matched
// case-insensitively. Extract it from a baseline filename to assert it is not a device.
function baseNameOfFile(file: string): string {
  const name = basename(file);
  const firstDot = name.indexOf('.');
  return (firstDot === -1 ? name : name.slice(0, firstDot)).toUpperCase();
}

const RESERVED_UPPER = new Set(RESERVED.map((r) => r.toUpperCase()));

describe('#1077 Windows reserved DOS device stack names', () => {
  it('every reserved device name (any case) no longer yields a device base name', () => {
    for (const name of [
      ...RESERVED,
      ...RESERVED.map((r) => r.toUpperCase()),
      'Nul',
      'CON',
      'CoM1',
    ]) {
      const p = baselinePath(name, '111122223333', 'us-east-1');
      expect(RESERVED_UPPER.has(baseNameOfFile(p))).toBe(false);
    }
  });

  it('sanitizes reserved names by appending an underscore to the base name only', () => {
    expect(sanitizeStackNameComponent('nul')).toBe('nul_');
    expect(sanitizeStackNameComponent('con')).toBe('con_');
    expect(sanitizeStackNameComponent('aux')).toBe('aux_');
    expect(sanitizeStackNameComponent('com1')).toBe('com1_');
    expect(sanitizeStackNameComponent('lpt9')).toBe('lpt9_');
    // case is preserved on the original base, only the reserved-ness is case-insensitive
    expect(sanitizeStackNameComponent('Nul')).toBe('Nul_');
    expect(sanitizeStackNameComponent('CON')).toBe('CON_');
  });

  it('a reserved base name followed by an extension is still sanitized (Win32 matches base only)', () => {
    // The Win32 device rule uses the part BEFORE the first dot — so `nul.foo` is also NUL.
    // (A CFn stack name cannot contain a dot, but defend the device rule at the base name.)
    expect(sanitizeStackNameComponent('nul.foo')).toBe('nul_.foo');
    expect(baseNameOfFile(baselinePath('nul.foo', '111122223333', 'us-east-1'))).not.toBe('NUL');
  });

  it('leaves a normal (non-reserved) stack name UNCHANGED', () => {
    for (const name of [
      'MyStack',
      'console',
      'nuller',
      'com',
      'com10',
      'lpt',
      'prod-api',
      'aux-service',
    ]) {
      expect(sanitizeStackNameComponent(name)).toBe(name);
      expect(baselinePath(name, '111122223333', 'us-east-1')).toBe(
        `.cdkrd/baselines/${name}.111122223333.us-east-1.json`
      );
    }
  });

  it('is injective over the VALID CFn stack-name domain: distinct names never collide', () => {
    // A valid CFn stack name is [A-Za-z][-A-Za-z0-9]* — letters, digits, hyphens ONLY, NEVER
    // an underscore. The transform inserts an `_`, so a transformed reserved name (nul_) can
    // never equal any plain (underscore-free) name — injectivity holds precisely BECAUSE the
    // domain excludes underscores. Check the reserved set plus near-miss plain names (which a
    // real stack CAN be named — `console`, `nuller`, `com`, `com10`) all map to DISTINCT
    // filenames. (`nul_` is NOT a valid CFn stack name, so it is intentionally excluded.)
    const names = [...RESERVED, 'MyStack', 'nuller', 'console', 'com', 'com10', 'lpt', 'aux-x'];
    const paths = names.map((n) => baselinePath(n, '111122223333', 'us-east-1'));
    expect(new Set(paths).size).toBe(paths.length);
    // and every reserved name maps to a DIFFERENT path than every other reserved name
    const reservedPaths = RESERVED.map((n) => baselinePath(n, '111122223333', 'us-east-1'));
    expect(new Set(reservedPaths).size).toBe(RESERVED.length);
  });

  it('is stable and deterministic: same input yields the same output', () => {
    for (const name of [...RESERVED, 'MyStack', 'Nul']) {
      const a = baselinePath(name, '111122223333', 'us-east-1');
      const b = baselinePath(name, '111122223333', 'us-east-1');
      expect(a).toBe(b);
      expect(sanitizeStackNameComponent(name)).toBe(sanitizeStackNameComponent(name));
    }
  });

  it('keeps accountId and region in the filename intact', () => {
    expect(baselinePath('nul', '111122223333', 'us-east-1')).toBe(
      '.cdkrd/baselines/nul_.111122223333.us-east-1.json'
    );
  });
});

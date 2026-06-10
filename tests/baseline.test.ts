import { describe, it, expect } from 'vitest';
import type { Finding } from '../src/types.js';
import { buildAccepted, applyBaseline, hashTemplate, type BaselineFile } from '../src/baseline/baseline-file.js';

const undeclared = (logicalId: string, path: string, value: unknown): Finding => ({ tier: 'undeclared', logicalId, resourceType: 'AWS::X::Y', path, actual: value });

function baseline(accepted: BaselineFile['accepted']): BaselineFile {
  return { schemaVersion: 1, stackName: 's', region: 'r', capturedAt: '', templateHash: '', accepted };
}

describe('baseline', () => {
  it('buildAccepted captures only undeclared findings', () => {
    const findings: Finding[] = [
      undeclared('A', 'P', [1]),
      { tier: 'declared', logicalId: 'B', resourceType: 'T', path: 'Q', desired: 1, actual: 2 },
      { tier: 'skipped', logicalId: 'C', resourceType: 'T', path: '' },
    ];
    expect(buildAccepted(findings)).toEqual([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: [1] }]);
  });

  it('applyBaseline suppresses a blessed undeclared value (-> CLEAN)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    expect(applyBaseline([undeclared('A', 'P', ['x'])], b)).toEqual([]);
  });

  it('applyBaseline keeps a CHANGED undeclared value (= drift)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    expect(applyBaseline([undeclared('A', 'P', ['y'])], b)).toHaveLength(1);
  });

  it('applyBaseline keeps a NEW undeclared path, passes non-undeclared through', () => {
    const b = baseline([]);
    const decl: Finding = { tier: 'declared', logicalId: 'B', resourceType: 'T', path: 'Q', desired: 1, actual: 2 };
    const out = applyBaseline([undeclared('A', 'NEW', 1), decl], b);
    expect(out).toHaveLength(2);
  });

  it('no baseline = pass everything through', () => {
    expect(applyBaseline([undeclared('A', 'P', 1)], undefined)).toHaveLength(1);
  });

  it('hashTemplate is stable + prefixed', () => {
    expect(hashTemplate('{}')).toBe(hashTemplate('{}'));
    expect(hashTemplate('{}')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  buildAccepted,
  checkBaselineAccount,
  hashTemplate,
  warnTemplateHashDrift,
} from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

const undeclared = (logicalId: string, path: string, value: unknown): Finding => ({
  tier: 'undeclared',
  logicalId,
  resourceType: 'AWS::X::Y',
  path,
  actual: value,
});

function baseline(accepted: BaselineFile['accepted'], accountId = '111122223333'): BaselineFile {
  return {
    schemaVersion: 1,
    stackName: 's',
    region: 'r',
    accountId,
    capturedAt: '',
    templateHash: '',
    accepted,
  };
}

describe('baseline', () => {
  it('buildAccepted captures only undeclared findings', () => {
    const findings: Finding[] = [
      undeclared('A', 'P', [1]),
      { tier: 'declared', logicalId: 'B', resourceType: 'T', path: 'Q', desired: 1, actual: 2 },
      { tier: 'skipped', logicalId: 'C', resourceType: 'T', path: '' },
    ];
    expect(buildAccepted(findings)).toEqual([
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: [1] },
    ]);
  });

  it('applyBaseline suppresses a blessed undeclared value (-> CLEAN)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    expect(applyBaseline([undeclared('A', 'P', ['x'])], b)).toEqual([]);
  });

  it('re-canonicalizes the blessed value before compare (old unsorted form still matches)', () => {
    // blessed under an OLDER rule set: tag list stored UNSORTED
    const b = baseline([
      {
        logicalId: 'A',
        resourceType: 'AWS::X::Y',
        path: 'Tags',
        value: [
          { Key: 'b', Value: '2' },
          { Key: 'a', Value: '1' },
        ],
      },
    ]);
    // current live finding.actual is canonical (sorted by Key), as classify produces
    const liveActual = [
      { Key: 'a', Value: '1' },
      { Key: 'b', Value: '2' },
    ];
    expect(applyBaseline([undeclared('A', 'Tags', liveActual)], b)).toEqual([]); // suppressed
  });

  it('applyBaseline keeps a CHANGED undeclared value (= drift)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    expect(applyBaseline([undeclared('A', 'P', ['y'])], b)).toHaveLength(1);
  });

  it('applyBaseline keeps a NEW undeclared path, passes non-undeclared through', () => {
    const b = baseline([]);
    const decl: Finding = {
      tier: 'declared',
      logicalId: 'B',
      resourceType: 'T',
      path: 'Q',
      desired: 1,
      actual: 2,
    };
    const out = applyBaseline([undeclared('A', 'NEW', 1), decl], b);
    expect(out).toHaveLength(2);
  });

  it('no baseline = pass everything through', () => {
    expect(applyBaseline([undeclared('A', 'P', 1)], undefined)).toHaveLength(1);
  });

  it('reports a blessed value that was removed since accept', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b); // nothing undeclared now
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      path: 'P',
      note: 'blessed value removed since accept',
    });
  });

  it('does NOT report a removal when the blessed path was promoted into the template', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['A', new Set(['P'])]]), // P is now declared
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0); // no false "removed" finding
    expect(warnings[0]).toContain('now declared in the template');
  });

  it('still reports a removal when the blessed path is genuinely gone (not declared)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, { declaredByLogical: new Map([['A', new Set(['Other'])]]) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ note: 'blessed value removed since accept' });
  });

  describe('warnTemplateHashDrift', () => {
    it('warns when the stored hash differs from the current template', () => {
      const b = { ...baseline([]), templateHash: hashTemplate('{"old":1}') };
      const warnings: string[] = [];
      warnTemplateHashDrift(b, '{"new":2}', 's', (m) => warnings.push(m));
      expect(warnings[0]).toContain('different template version');
    });
    it('is silent when the hash matches (or is absent)', () => {
      const tmpl = '{"x":1}';
      const b = { ...baseline([]), templateHash: hashTemplate(tmpl) };
      const warnings: string[] = [];
      warnTemplateHashDrift(b, tmpl, 's', (m) => warnings.push(m));
      warnTemplateHashDrift({ ...baseline([]), templateHash: '' }, tmpl, 's', (m) =>
        warnings.push(m)
      );
      expect(warnings).toHaveLength(0);
    });
  });

  it('hashTemplate is stable + prefixed', () => {
    expect(hashTemplate('{}')).toBe(hashTemplate('{}'));
    expect(hashTemplate('{}')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  describe('checkBaselineAccount (per-account guard)', () => {
    it('passes when the account matches', () => {
      expect(() => checkBaselineAccount(baseline([]), '111122223333', 's')).not.toThrow();
    });

    it('throws on an account mismatch (dev baseline vs prod account)', () => {
      expect(() => checkBaselineAccount(baseline([], '111122223333'), '999988887777', 's')).toThrow(
        /account 111122223333.*current account is 999988887777/s
      );
    });

    it('only warns (does not throw) for an older baseline with no accountId', () => {
      const warnings: string[] = [];
      const old = { ...baseline([]), accountId: '' };
      expect(() =>
        checkBaselineAccount(old, '999988887777', 's', (m) => warnings.push(m))
      ).not.toThrow();
      expect(warnings[0]).toContain('no accountId');
    });
  });
});

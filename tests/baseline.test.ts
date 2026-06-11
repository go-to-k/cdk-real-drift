import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  acceptedKey,
  applyBaseline,
  type BaselineFile,
  baselinePath,
  buildAccepted,
  checkBaselineAccount,
  hashTemplate,
  selectAccepted,
  warnTemplateHashDrift,
  writeBaseline,
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
  describe('baselinePath (per-account filename, R21)', () => {
    it('embeds stack, accountId, and region', () => {
      expect(baselinePath('MyStack', '123456789012', 'ap-northeast-1')).toBe(
        '.cdkrd/MyStack.123456789012.ap-northeast-1.json'
      );
    });

    it('same stack + region in two accounts -> distinct paths (coexistence)', () => {
      const shared = baselinePath('MyStack', '123456789012', 'ap-northeast-1');
      const personal = baselinePath('MyStack', '999988887777', 'ap-northeast-1');
      expect(shared).not.toBe(personal);
    });
  });

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

  describe('selectAccepted (selective accept)', () => {
    const findings: Finding[] = [
      undeclared('A', 'P', [1]),
      undeclared('B', 'Q', 'x'),
      { tier: 'declared', logicalId: 'C', resourceType: 'T', path: 'R', desired: 1, actual: 2 },
    ];

    it('returns only the entries whose key is in the selected set', () => {
      expect(
        selectAccepted(findings, new Set([acceptedKey({ logicalId: 'B', path: 'Q' })]))
      ).toEqual([{ logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 'x' }]);
    });

    it('empty selection -> []', () => {
      expect(selectAccepted(findings, new Set())).toEqual([]);
    });

    it('all selected -> equals buildAccepted output', () => {
      const all = new Set(buildAccepted(findings).map(acceptedKey));
      expect(selectAccepted(findings, all)).toEqual(buildAccepted(findings));
    });
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

  describe('writeBaseline (deterministic order, R40)', () => {
    // capturedAt is fixed so the only variable across writes is the accepted order.
    const entry = (logicalId: string, path: string): BaselineFile['accepted'][number] => ({
      logicalId,
      resourceType: 'AWS::X::Y',
      path,
      value: [logicalId, path],
    });
    const withOrder = (accepted: BaselineFile['accepted']): BaselineFile => ({
      ...baseline(accepted),
      capturedAt: '2026-06-12T00:00:00.000Z',
    });

    async function writeInTmp(b: BaselineFile): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const p = await writeBaseline(b);
        return await readFile(p, 'utf8');
      } finally {
        process.chdir(cwd);
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('same entries in different order -> byte-identical file', async () => {
      const orderA = [entry('B', 'q'), entry('A', 'p'), entry('A', 'a')];
      const orderB = [entry('A', 'a'), entry('B', 'q'), entry('A', 'p')];
      const a = await writeInTmp(withOrder(orderA));
      const b = await writeInTmp(withOrder(orderB));
      expect(a).toBe(b);
    });

    it('writes accepted sorted lexicographically by (logicalId, path)', async () => {
      const out = await writeInTmp(withOrder([entry('B', 'q'), entry('A', 'p'), entry('A', 'a')]));
      const parsed = JSON.parse(out) as BaselineFile;
      expect(parsed.accepted.map((e) => `${e.logicalId}.${e.path}`)).toEqual(['A.a', 'A.p', 'B.q']);
    });

    it('does not mutate the caller-supplied accepted array', async () => {
      const accepted = [entry('B', 'q'), entry('A', 'p')];
      const snapshot = accepted.map((e) => e.logicalId);
      await writeInTmp(withOrder(accepted));
      expect(accepted.map((e) => e.logicalId)).toEqual(snapshot);
    });
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

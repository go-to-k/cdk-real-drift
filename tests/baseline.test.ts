import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  recordedKey,
  applyBaseline,
  type BaselineFile,
  baselinePath,
  buildRecorded,
  checkBaselineAccount,
  computeCompleteResources,
  hashTemplate,
  loadBaseline,
  selectRecorded,
  splitRecordedByBaseline,
  warnBaselineSchemaV1,
  warnTemplateHashDrift,
  writeBaseline,
  writeBaselineFile,
} from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

const undeclared = (logicalId: string, path: string, value: unknown): Finding => ({
  tier: 'undeclared',
  logicalId,
  resourceType: 'AWS::X::Y',
  path,
  actual: value,
});

function baseline(recorded: BaselineFile['recorded'], accountId = '111122223333'): BaselineFile {
  return {
    schemaVersion: 1,
    stackName: 's',
    region: 'r',
    accountId,
    capturedAt: '',
    templateHash: '',
    recorded,
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

  it('buildRecorded captures only undeclared findings', () => {
    const findings: Finding[] = [
      undeclared('A', 'P', [1]),
      { tier: 'declared', logicalId: 'B', resourceType: 'T', path: 'Q', desired: 1, actual: 2 },
      { tier: 'skipped', logicalId: 'C', resourceType: 'T', path: '' },
    ];
    expect(buildRecorded(findings)).toEqual([
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: [1] },
    ]);
  });

  describe('selectRecorded (selective record)', () => {
    const findings: Finding[] = [
      undeclared('A', 'P', [1]),
      undeclared('B', 'Q', 'x'),
      { tier: 'declared', logicalId: 'C', resourceType: 'T', path: 'R', desired: 1, actual: 2 },
    ];

    it('returns only the entries whose key is in the selected set', () => {
      expect(
        selectRecorded(findings, new Set([recordedKey({ logicalId: 'B', path: 'Q' })]))
      ).toEqual([{ logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 'x' }]);
    });

    it('empty selection -> []', () => {
      expect(selectRecorded(findings, new Set())).toEqual([]);
    });

    it('all selected -> equals buildRecorded output', () => {
      const all = new Set(buildRecorded(findings).map(recordedKey));
      expect(selectRecorded(findings, all)).toEqual(buildRecorded(findings));
    });
  });

  describe('splitRecordedByBaseline (delta-only record, R39)', () => {
    const recorded = [
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }, // unchanged
      { logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 'new-val' }, // changed value
      { logicalId: 'C', resourceType: 'AWS::X::Y', path: 'R', value: 1 }, // new path
    ];

    it('3-way buckets unchanged / changed-value / new-path correctly', () => {
      const b = baseline([
        { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] },
        { logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 'old-val' },
        // C.R absent from baseline => new
      ]);
      const { unchanged, changed } = splitRecordedByBaseline(recorded, b);
      expect(unchanged).toEqual([
        { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] },
      ]);
      expect(changed).toEqual([
        { logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 'new-val' },
        { logicalId: 'C', resourceType: 'AWS::X::Y', path: 'R', value: 1 },
      ]);
    });

    it('R6 regression: a baseline value in an OLDER canonical form is still unchanged', () => {
      // recorded under an OLDER rule set: IAM policy Action stored as a scalar; the current
      // canonical value (from buildRecorded) is the sorted-array form. canonicalizeForCompare
      // folds them together, so this must bucket as unchanged (not changed).
      const b = baseline([
        {
          logicalId: 'A',
          resourceType: 'AWS::IAM::Role',
          path: 'AssumeRolePolicyDocument',
          value: { Statement: [{ Effect: 'Allow', Action: 's3:Get' }] }, // scalar Action
        },
      ]);
      const current = [
        {
          logicalId: 'A',
          resourceType: 'AWS::IAM::Role',
          path: 'AssumeRolePolicyDocument',
          value: { Statement: [{ Effect: 'Allow', Action: ['s3:Get'] }] }, // canonical array
        },
      ];
      const { unchanged, changed } = splitRecordedByBaseline(current, b);
      expect(unchanged).toHaveLength(1);
      expect(changed).toHaveLength(0);
    });

    it('no baseline -> everything is changed (the true first record)', () => {
      const { unchanged, changed } = splitRecordedByBaseline(recorded, undefined);
      expect(unchanged).toEqual([]);
      expect(changed).toEqual(recorded);
    });

    it('no new/changed -> changed empty, all unchanged (the refresh path)', () => {
      const b = baseline(recorded.map((e) => ({ ...e })));
      const { unchanged, changed } = splitRecordedByBaseline(recorded, b);
      expect(unchanged).toEqual(recorded);
      expect(changed).toEqual([]);
    });

    it('final written set = unchanged + selected (an unselected new entry is excluded)', () => {
      // emulate recordStack's composition: auto-kept unchanged + user-picked changed.
      const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
      const { unchanged, changed } = splitRecordedByBaseline(recorded, b);
      // user selects only B.Q (the changed value), leaves the new C.R unselected
      const selected = changed.filter((e) => e.logicalId === 'B');
      const written = [...unchanged, ...selected];
      expect(written).toEqual([
        { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] },
        { logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 'new-val' },
      ]);
      // the unselected new path C.R is NOT recorded
      expect(written.some((e) => e.logicalId === 'C')).toBe(false);
    });
  });

  it('applyBaseline suppresses an recorded undeclared value (-> CLEAN)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    expect(applyBaseline([undeclared('A', 'P', ['x'])], b)).toEqual([]);
  });

  describe('atDefault reconciliation (R86 — folded inventory, never drift, never a false removal)', () => {
    const atDefault = (logicalId: string, path: string, value: unknown): Finding => ({
      tier: 'atDefault',
      logicalId,
      resourceType: 'AWS::Lambda::Function',
      path,
      actual: value,
    });

    it('an at-default value with no baseline entry passes through folded (not unrecorded, not drift)', () => {
      const out = applyBaseline(
        [atDefault('A', 'TracingConfig', { Mode: 'PassThrough' })],
        baseline([])
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ tier: 'atDefault', path: 'TracingConfig' });
      expect(out[0]!.unrecorded).toBeUndefined();
    });

    it('with NO baseline at all, an at-default value stays atDefault (only undeclared is tagged unrecorded)', () => {
      const out = applyBaseline([atDefault('A', 'PackageType', 'Zip')], undefined);
      expect(out[0]).toMatchObject({ tier: 'atDefault' });
      expect(out[0]!.unrecorded).toBeUndefined();
    });

    it('a value the user recorded that is now classified at-default is SUPPRESSED, not reported as removed (the live regression)', () => {
      // baseline recorded Encryption=<AES256>; today classify tags it atDefault (it now
      // matches a known default). It must vanish (already decided), and must NOT appear
      // as "baseline value removed since record".
      const b = baseline([
        {
          logicalId: 'Bkt',
          resourceType: 'AWS::S3::Bucket',
          path: 'Encryption',
          value: { alg: 'AES256' },
        },
      ]);
      const out = applyBaseline([atDefault('Bkt', 'Encryption', { alg: 'AES256' })], b);
      expect(out).toEqual([]);
    });
  });

  it('re-canonicalizes the baseline value before compare (old unsorted form still matches)', () => {
    // recorded under an OLDER rule set: tag list stored UNSORTED
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

  it('applyBaseline keeps a NEW undeclared path (unrecorded on a never-complete resource), passes non-undeclared through', () => {
    const b = baseline([]); // v1: no completeResources -> nothing is snapshot-complete
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
    expect(out[0]).toMatchObject({ path: 'NEW', unrecorded: true });
    expect(out[1]).toBe(decl);
  });

  it('no baseline = everything undeclared survives, tagged unrecorded (R62)', () => {
    const out = applyBaseline([undeclared('A', 'P', 1)], undefined);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'undeclared', unrecorded: true });
  });

  describe('per-entry classification (R62 — unrecorded vs appeared-since-record)', () => {
    const v2 = (recorded: BaselineFile['recorded'], completeResources: string[]): BaselineFile => ({
      ...baseline(recorded),
      schemaVersion: 2,
      completeResources,
    });

    it('entry-less value on a snapshot-COMPLETE resource -> drift, noted as appeared since record', () => {
      const b = v2([], ['A']);
      const out = applyBaseline([undeclared('A', 'NEW', 1)], b);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ tier: 'undeclared', note: 'appeared since record' });
      expect(out[0]!.unrecorded).toBeUndefined();
    });

    it('entry-less value on a NOT-complete resource -> unrecorded, even though the file exists', () => {
      // the cherry-pick case: recording one value on B must not flip A's values to drift
      const b = v2([{ logicalId: 'B', resourceType: 'AWS::X::Y', path: 'P', value: 1 }], ['B']);
      const out = applyBaseline([undeclared('A', 'NEW', 1)], b);
      expect(out[0]).toMatchObject({ unrecorded: true });
    });

    it('recorded value that CHANGED is drift (never unrecorded), complete or not', () => {
      const b = v2([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }], []);
      const out = applyBaseline([undeclared('A', 'P', ['y'])], b);
      expect(out).toHaveLength(1);
      expect(out[0]!.unrecorded).toBeUndefined();
    });

    it('appends the appeared-since-record note after an existing note', () => {
      const b = v2([], ['A']);
      const f = { ...undeclared('A', 'NEW', 1), note: 'prior' };
      const out = applyBaseline([f], b);
      expect(out[0]!.note).toBe('prior; appeared since record');
    });
  });

  describe('computeCompleteResources (R62 — what the record snapshot covered)', () => {
    it('covered, uncovered, unread, and clean resources bucket correctly', () => {
      const findings: Finding[] = [
        undeclared('Covered', 'P', 1),
        undeclared('Uncovered', 'P', 1),
        { tier: 'skipped', logicalId: 'Unread', resourceType: 'T', path: '' },
        { tier: 'deleted', logicalId: 'Gone', resourceType: 'T', path: '' },
      ];
      const recorded = [{ logicalId: 'Covered', resourceType: 'AWS::X::Y', path: 'P', value: 1 }];
      expect(
        computeCompleteResources(
          ['Covered', 'Uncovered', 'Unread', 'Gone', 'Clean'],
          findings,
          recorded
        )
      ).toEqual(['Clean', 'Covered']); // sorted; Uncovered/Unread/Gone excluded
    });

    it('a resource with one of two values recorded is NOT complete', () => {
      const findings = [undeclared('A', 'P', 1), undeclared('A', 'Q', 2)];
      const recorded = [{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: 1 }];
      expect(computeCompleteResources(['A'], findings, recorded)).toEqual([]);
    });

    it('ignored-tier values do not block completeness (visible, deliberately ruled out)', () => {
      const findings: Finding[] = [
        { tier: 'ignored', logicalId: 'A', resourceType: 'T', path: 'P', actual: 1 },
      ];
      expect(computeCompleteResources(['A'], findings, [])).toEqual(['A']);
    });

    it('monotonic: a previously-complete resource stays complete when a new value is declined', () => {
      // the appeared value was shown as drift; declining it must not demote to unrecorded
      const findings = [undeclared('A', 'NEW', 1)];
      expect(computeCompleteResources(['A'], findings, [], ['A'])).toEqual(['A']);
    });

    it('previous completeness is pruned to ids still in the template', () => {
      expect(computeCompleteResources(['B'], [], [], ['A', 'B'])).toEqual(['B']);
    });
  });

  describe('warnBaselineSchemaV1 (R62)', () => {
    it('warns when completeResources is absent (schema v1)', () => {
      const warnings: string[] = [];
      warnBaselineSchemaV1(baseline([]), 's', (m) => warnings.push(m));
      expect(warnings[0]).toContain('predates snapshot tracking');
    });
    it('silent on a v2 file', () => {
      const warnings: string[] = [];
      warnBaselineSchemaV1({ ...baseline([]), completeResources: [] }, 's', (m) =>
        warnings.push(m)
      );
      expect(warnings).toEqual([]);
    });
  });

  it('reports a baseline value that was removed since record', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b); // nothing undeclared now
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      path: 'P',
      note: 'baseline value removed since record',
    });
  });

  it('does NOT report a removal when the recorded path was promoted into the template', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['A', new Set(['P'])]]), // P is now declared
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0); // no false "removed" finding
    expect(warnings[0]).toContain('now declared in the template');
  });

  it('still reports a removal when the recorded path is genuinely gone (not declared)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, { declaredByLogical: new Map([['A', new Set(['Other'])]]) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ note: 'baseline value removed since record' });
  });

  describe('writeBaselineFile (deterministic order, R40)', () => {
    // capturedAt is fixed so the only variable across writes is the recorded order.
    const entry = (logicalId: string, path: string): BaselineFile['recorded'][number] => ({
      logicalId,
      resourceType: 'AWS::X::Y',
      path,
      value: [logicalId, path],
    });
    const withOrder = (recorded: BaselineFile['recorded']): BaselineFile => ({
      ...baseline(recorded),
      capturedAt: '2026-06-12T00:00:00.000Z',
    });

    async function writeInTmp(b: BaselineFile): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const p = await writeBaselineFile(b);
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

    it('writes recorded sorted lexicographically by (logicalId, path)', async () => {
      const out = await writeInTmp(withOrder([entry('B', 'q'), entry('A', 'p'), entry('A', 'a')]));
      const parsed = JSON.parse(out) as BaselineFile;
      expect(parsed.recorded.map((e) => `${e.logicalId}.${e.path}`)).toEqual(['A.a', 'A.p', 'B.q']);
    });

    it('does not mutate the caller-supplied recorded array', async () => {
      const recorded = [entry('B', 'q'), entry('A', 'p')];
      const snapshot = recorded.map((e) => e.logicalId);
      await writeInTmp(withOrder(recorded));
      expect(recorded.map((e) => e.logicalId)).toEqual(snapshot);
    });

    it('writes completeResources sorted (byte-stable, R62)', async () => {
      const out = await writeInTmp({ ...withOrder([]), completeResources: ['B', 'A'] });
      expect((JSON.parse(out) as BaselineFile).completeResources).toEqual(['A', 'B']);
    });
  });

  describe('writeBaseline (schema v2, R62)', () => {
    it('stamps schemaVersion 2 and the completeResources snapshot', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const findings = [undeclared('A', 'P', 1), undeclared('B', 'Q', 2)];
        // selective record: only A.P — so A is complete, B is not, Clean trivially is
        const { path } = await writeBaseline(
          's',
          'r',
          '111122223333',
          findings,
          '{}',
          [{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: 1 }],
          { allLogicalIds: ['A', 'B', 'Clean'] }
        );
        const parsed = JSON.parse(await readFile(path, 'utf8')) as BaselineFile;
        expect(parsed.schemaVersion).toBe(2);
        expect(parsed.completeResources).toEqual(['A', 'Clean']);
      } finally {
        process.chdir(cwd);
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('loadBaseline back-compat (accept→record field rename)', () => {
    it('reads a pre-rename baseline that stored entries under the old `accepted` key', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const p = baselinePath('s', '111122223333', 'r');
        await mkdir(dirname(p), { recursive: true });
        // an OLD baseline (field `accepted`, no `recorded`)
        const legacy = {
          schemaVersion: 2,
          stackName: 's',
          region: 'r',
          accountId: '111122223333',
          capturedAt: '2026-01-01T00:00:00Z',
          templateHash: 'sha256:x',
          accepted: [{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: 1 }],
        };
        await writeFile(p, JSON.stringify(legacy), 'utf8');
        const loaded = await loadBaseline('s', '111122223333', 'r');
        expect(loaded?.recorded).toEqual([
          { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: 1 },
        ]);
        // the legacy key is not carried forward
        expect((loaded as unknown as { accepted?: unknown }).accepted).toBeUndefined();
      } finally {
        process.chdir(cwd);
        await rm(dir, { recursive: true, force: true });
      }
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

describe('nested undeclared through the baseline (R96)', () => {
  const nf = (path: string, val: unknown): Finding => ({
    tier: 'undeclared',
    logicalId: 'L',
    resourceType: 'T',
    path,
    actual: val,
    nested: true,
  });
  it('no baseline -> nested undeclared is unrecorded inventory (folded downstream)', () => {
    const out = applyBaseline([nf('Conf.X', 'default')], undefined);
    expect(out[0]).toMatchObject({ tier: 'undeclared', path: 'Conf.X', unrecorded: true });
  });
  it('recorded + unchanged -> suppressed (CLEAN)', () => {
    const b = baseline([{ logicalId: 'L', resourceType: 'T', path: 'Conf.X', value: 'default' }]);
    expect(applyBaseline([nf('Conf.X', 'default')], b)).toEqual([]);
  });
  it('recorded then a nested value CHANGES out of band -> drift (the depth differentiator)', () => {
    const b = baseline([{ logicalId: 'L', resourceType: 'T', path: 'Conf.X', value: 'default' }]);
    const out = applyBaseline([nf('Conf.X', 'EDITED')], b);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'undeclared', path: 'Conf.X' });
    expect(out[0]!.unrecorded).toBeUndefined(); // it is drift, not unrecorded
  });
});

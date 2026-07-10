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
  carryForwardUnreadable,
  constructPathsByLogical,
  physicalIdsByLogical,
  formatPromotedStaleNote,
  formatRemovedFromTemplateNote,
  formatReplacedStaleNote,
  identityArrayDelta,
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
        '.cdkrd/baselines/MyStack.123456789012.ap-northeast-1.json'
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
    const atDefault = (
      logicalId: string,
      path: string,
      value: unknown,
      resourceType = 'AWS::Lambda::Function'
    ): Finding => ({
      tier: 'atDefault',
      logicalId,
      resourceType,
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
      const out = applyBaseline(
        [atDefault('Bkt', 'Encryption', { alg: 'AES256' }, 'AWS::S3::Bucket')],
        b
      );
      expect(out).toEqual([]);
    });

    it('a recorded NON-default value reset to the AWS default IS drift (not folded away)', () => {
      // baseline recorded MaxSessionDuration=7200 (a tweak); someone resets it out of
      // band to the 3600 default, which classify tags `atDefault`. Because the value
      // CHANGED from the baseline, it must surface as drift — forced to tier
      // `undeclared` so it is counted (atDefault is informational, not a drift tier).
      const b = baseline([
        { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'MaxSessionDuration', value: 7200 },
      ]);
      const out = applyBaseline([atDefault('A', 'MaxSessionDuration', 3600, 'AWS::IAM::Role')], b);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        tier: 'undeclared',
        path: 'MaxSessionDuration',
        actual: 3600,
      });
    });

    it('a recorded value changed to an AWS-GENERATED form IS drift (generalizes the atDefault case)', () => {
      // same class as the atDefault reset, for the `generated` tier: a recorded
      // undeclared LogFormat reset out of band to the AWS-generated default. classify
      // tags today's value `generated`; because it CHANGED from the baseline it must
      // surface as drift, not be folded as generated nor mislabeled "removed".
      const generated = (logicalId: string, path: string, value: unknown): Finding => ({
        tier: 'generated',
        logicalId,
        resourceType: 'AWS::Lambda::Function',
        path,
        actual: value,
      });
      const b = baseline([
        {
          logicalId: 'Fn',
          resourceType: 'AWS::Lambda::Function',
          path: 'LogFormat',
          value: 'JSON',
        },
      ]);
      const out = applyBaseline([generated('Fn', 'LogFormat', 'Text')], b);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ tier: 'undeclared', path: 'LogFormat', actual: 'Text' });
      // and NOT a duplicate "removed since record" entry
      expect(out.some((f) => f.note === 'baseline value removed since record')).toBe(false);
    });

    it('a generated value with NO baseline entry passes through folded (not removed, not drift)', () => {
      const generated: Finding = {
        tier: 'generated',
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'LoggingConfig',
        actual: { LogGroup: '/aws/lambda/x' },
      };
      const out = applyBaseline([generated], baseline([]));
      expect(out).toEqual([generated]);
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

  describe('identityArrayDelta (R128 — element-level granularity for recorded arrays)', () => {
    const p = (name: string, doc: unknown) => ({ PolicyName: name, PolicyDocument: doc });

    it('returns undefined when not both arrays', () => {
      expect(identityArrayDelta('x', ['y'])).toBeUndefined();
      expect(identityArrayDelta([{ PolicyName: 'a' }], { PolicyName: 'a' })).toBeUndefined();
    });

    it('returns undefined when no shared unique identity field (whole-array fallback)', () => {
      // objects with no Key/Id/PolicyName/Name -> cannot align
      expect(identityArrayDelta([{ Effect: 'Allow' }], [{ Effect: 'Deny' }])).toBeUndefined();
    });

    it('returns undefined when a candidate identity is non-unique (avoid mis-aligned delta)', () => {
      const rec = [p('dup', 1), p('dup', 2)];
      const live = [p('dup', 1), p('dup', 3)];
      expect(identityArrayDelta(rec, live)).toBeUndefined();
    });

    it('returns undefined for a pure reorder (nothing actually changed)', () => {
      const rec = [p('a', 1), p('b', 2)];
      const live = [p('b', 2), p('a', 1)];
      expect(identityArrayDelta(rec, live)).toBeUndefined();
    });

    it('detects an ADDED element keyed by PolicyName (the user-hit case)', () => {
      const rec = [p('a', 1)];
      const live = [p('a', 1), p('aaa', 2)];
      const d = identityArrayDelta(rec, live);
      expect(d).toMatchObject({ identityField: 'PolicyName' });
      expect(d?.added).toEqual([{ id: 'aaa', value: p('aaa', 2) }]);
      expect(d?.changed).toEqual([]);
      expect(d?.removed).toEqual([]);
    });

    it('detects a CHANGED element (same name, different document) — not missed', () => {
      const rec = [p('a', { act: 's3:Get' })];
      const live = [p('a', { act: 's3:*' })];
      const d = identityArrayDelta(rec, live);
      expect(d?.added).toEqual([]);
      expect(d?.changed).toEqual([
        { id: 'a', recorded: p('a', { act: 's3:Get' }), actual: p('a', { act: 's3:*' }) },
      ]);
    });

    it('detects a REMOVED element', () => {
      const rec = [p('a', 1), p('b', 2)];
      const live = [p('a', 1)];
      const d = identityArrayDelta(rec, live);
      expect(d?.removed).toEqual([{ id: 'b', value: p('b', 2) }]);
    });

    it('applyBaseline attaches arrayDelta to a changed recorded array (display-only, path stays whole)', () => {
      const b = baseline([
        { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'Policies', value: [p('a', 1)] },
      ]);
      const out = applyBaseline([undeclared('A', 'Policies', [p('a', 1), p('aaa', 2)])], b);
      expect(out).toHaveLength(1);
      expect(out[0].path).toBe('Policies'); // whole-array path preserved (record unaffected)
      expect(out[0].arrayDelta?.added).toEqual([{ id: 'aaa', value: p('aaa', 2) }]);
    });

    it('applyBaseline leaves a changed scalar array without arrayDelta (whole-array fallback)', () => {
      const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
      const out = applyBaseline([undeclared('A', 'P', ['y'])], b);
      expect(out[0].arrayDelta).toBeUndefined();
    });
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

  describe('added-resource reconciliation (PR4 — `added` is record-able, full mirror of undeclared)', () => {
    const added = (logicalId: string, value: unknown): Finding => ({
      tier: 'added',
      logicalId,
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
      physicalId: logicalId.split('/')[1] ?? logicalId,
      actual: value,
      note: 'created out of band — not in your CloudFormation template',
    });

    it('no baseline -> an added resource is unrecorded (inventory), not drift', () => {
      const out = applyBaseline([added('Api/m1', { AuthorizationType: 'NONE' })], undefined);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ tier: 'added', unrecorded: true });
    });

    it('with a baseline but NO entry for the added resource -> unrecorded, not drift', () => {
      const b = baseline([{ logicalId: 'Other', resourceType: 'AWS::X::Y', path: 'P', value: 1 }]);
      const out = applyBaseline([added('Api/m1', { AuthorizationType: 'NONE' })], b);
      expect(out[0]).toMatchObject({ tier: 'added', unrecorded: true });
    });

    it('a recorded + unchanged added resource is suppressed', () => {
      const b = baseline([
        {
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          value: { AuthorizationType: 'NONE' },
        },
      ]);
      const out = applyBaseline([added('Api/m1', { AuthorizationType: 'NONE' })], b);
      expect(out).toHaveLength(0);
    });

    it('a recorded + CHANGED added resource stays `added` drift with baseline + changed note', () => {
      const b = baseline([
        {
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          value: { AuthorizationType: 'NONE' },
        },
      ]);
      const out = applyBaseline([added('Api/m1', { AuthorizationType: 'AWS_IAM' })], b);
      expect(out).toHaveLength(1);
      expect(out[0]!.tier).toBe('added');
      expect(out[0]!.unrecorded).toBeUndefined();
      expect(out[0]!.desired).toEqual({ AuthorizationType: 'NONE' });
      expect(out[0]!.actual).toEqual({ AuthorizationType: 'AWS_IAM' });
      expect(out[0]!.note).toContain('changed since record');
    });

    it('a degraded read (modelReadFailed) is never false-flagged as "changed" — recorded → suppressed', () => {
      const b = baseline([
        {
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          value: { AuthorizationType: 'NONE' },
        },
      ]);
      // the live read returned only the identity snippet (full model unreadable this run)
      const f = { ...added('Api/m1', { HttpMethod: 'ANY' }), modelReadFailed: true };
      expect(applyBaseline([f], b)).toHaveLength(0); // suppressed, not "changed"
    });

    it('a degraded read with NO baseline entry stays Not-Recorded (not drift)', () => {
      const f = { ...added('Api/m1', { HttpMethod: 'ANY' }), modelReadFailed: true };
      const out = applyBaseline([f], baseline([]));
      expect(out[0]).toMatchObject({ tier: 'added', unrecorded: true });
    });

    it('an added-resource baseline entry whose live resource is GONE is not a false removal', () => {
      // the out-of-band resource was deleted after record — nothing to "restore"; the
      // empty-path entry must be skipped by the removal pass (no phantom undeclared finding).
      const b = baseline([
        {
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          value: { AuthorizationType: 'NONE' },
        },
      ]);
      const out = applyBaseline([], b);
      expect(out).toHaveLength(0);
    });
  });

  describe('buildRecorded includes added resources (PR4)', () => {
    it('snapshots both undeclared properties and out-of-band added resources', () => {
      const recorded = buildRecorded([
        undeclared('B', 'AccelerateConfiguration', { S: 1 }),
        {
          tier: 'added',
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          actual: { AuthorizationType: 'NONE' },
        },
        // not recorded: declared / atDefault / generated
        { tier: 'declared', logicalId: 'B', resourceType: 'AWS::X::Y', path: 'P', actual: 1 },
      ]);
      expect(recorded).toHaveLength(2);
      expect(recorded.find((e) => e.logicalId === 'Api/m1')).toMatchObject({
        path: '',
        value: { AuthorizationType: 'NONE' },
      });
      expect(recordedKey(recorded.find((e) => e.logicalId === 'Api/m1')!)).toBe('Api/m1::');
    });

    it('never snapshots an added resource whose model read failed (avoids a partial baseline)', () => {
      const recorded = buildRecorded([
        {
          tier: 'added',
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          actual: { HttpMethod: 'ANY' },
          modelReadFailed: true,
        },
      ]);
      expect(recorded).toHaveLength(0);
    });
  });

  describe('carryForwardUnreadable (re-record never shrinks the baseline for unread resources)', () => {
    const prior = baseline([
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: 1 },
      { logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: 2 },
    ]);

    it('preserves a prior entry whose resource was SKIPPED this run', () => {
      // This run read A (undeclared) but could not read B (skipped) -> B must survive.
      const findings: Finding[] = [
        undeclared('A', 'P', 1),
        { tier: 'skipped', logicalId: 'B', resourceType: 'AWS::X::Y', path: '' },
      ];
      const out = carryForwardUnreadable(buildRecorded(findings), prior, findings);
      expect(out).toContainEqual({
        logicalId: 'B',
        resourceType: 'AWS::X::Y',
        path: 'Q',
        value: 2,
      });
      // A reflects this run's freshly-read value, not the stale prior one.
      expect(out.find((e) => e.logicalId === 'A')).toMatchObject({ value: 1 });
    });

    it('preserves a prior added entry whose model read failed this run', () => {
      const prevAdded = baseline([
        { logicalId: 'Api/m1', resourceType: 'AWS::ApiGateway::Method', path: '', value: { X: 1 } },
      ]);
      const findings: Finding[] = [
        {
          tier: 'added',
          logicalId: 'Api/m1',
          resourceType: 'AWS::ApiGateway::Method',
          path: '',
          actual: { X: 1 },
          modelReadFailed: true,
        },
      ];
      // buildRecorded drops the modelReadFailed entry; carry-forward restores it.
      expect(buildRecorded(findings)).toHaveLength(0);
      const out = carryForwardUnreadable(buildRecorded(findings), prevAdded, findings);
      expect(out).toContainEqual({
        logicalId: 'Api/m1',
        resourceType: 'AWS::ApiGateway::Method',
        path: '',
        value: { X: 1 },
      });
    });

    it('does NOT resurrect a prior entry for a resource read CLEAN this run (value returned to default)', () => {
      // B was read clean (no undeclared finding) -> its value legitimately went to default; drop it.
      const findings: Finding[] = [undeclared('A', 'P', 1)];
      const out = carryForwardUnreadable(buildRecorded(findings), prior, findings);
      expect(out.find((e) => e.logicalId === 'B')).toBeUndefined();
    });

    it('does NOT resurrect a prior entry for a DELETED resource (genuinely gone)', () => {
      const findings: Finding[] = [
        { tier: 'deleted', logicalId: 'B', resourceType: 'AWS::X::Y', path: '' },
      ];
      const out = carryForwardUnreadable(buildRecorded(findings), prior, findings);
      expect(out.find((e) => e.logicalId === 'B')).toBeUndefined();
    });

    it('does not duplicate an entry already present in this run', () => {
      const findings: Finding[] = [
        undeclared('B', 'Q', 2),
        { tier: 'skipped', logicalId: 'B', resourceType: 'AWS::X::Y', path: '' },
      ];
      const out = carryForwardUnreadable(buildRecorded(findings), prior, findings);
      expect(out.filter((e) => e.logicalId === 'B' && e.path === 'Q')).toHaveLength(1);
    });

    it('no-ops with no prior baseline', () => {
      const findings: Finding[] = [undeclared('A', 'P', 1)];
      expect(carryForwardUnreadable(buildRecorded(findings), undefined, findings)).toEqual(
        buildRecorded(findings)
      );
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

    it('a resource with a readGap finding is NOT complete (#795 — part of its model was unread)', () => {
      // a readGap means some of the resource's live state could not be read this run,
      // so undeclared values hidden behind the gap were never snapshotted — the
      // resource must not be stamped complete (else a later cdkrd that closes the gap
      // surfaces the newly-visible values as false "appeared since record" drift).
      const findings: Finding[] = [
        { tier: 'readGap', logicalId: 'Gap', resourceType: 'T', path: 'P' },
      ];
      expect(computeCompleteResources(['Gap'], findings, [])).toEqual([]);
    });

    it('a resource with one of two values recorded is NOT complete', () => {
      const findings = [undeclared('A', 'P', 1), undeclared('A', 'Q', 2)];
      const recorded = [{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: 1 }];
      expect(computeCompleteResources(['A'], findings, recorded)).toEqual([]);
    });

    it('#1078: an ignored value whose path IS recorded does not block completeness', () => {
      // The value was carried into `recorded` (carryForwardIgnored) — an endorsed value
      // stays complete even while an ignore rule suppresses reporting it. Preserves the
      // intended behavior for recorded values.
      const findings: Finding[] = [
        { tier: 'ignored', logicalId: 'A', resourceType: 'T', path: 'P', actual: 1 },
      ];
      const recorded = [{ logicalId: 'A', resourceType: 'T', path: 'P', value: 1 }];
      expect(computeCompleteResources(['A'], findings, recorded)).toEqual(['A']);
    });

    it('#1078: an ignored-and-UNRECORDED value blocks completeness (un-ignore must round-trip)', () => {
      // No recorded entry for the ignored path: marking the resource complete would treat
      // the value as known-absent, so deleting the rule (un-ignore) would false-surface the
      // untouched value as confirmed "appeared since record". It must stay INCOMPLETE.
      const findings: Finding[] = [
        { tier: 'ignored', logicalId: 'A', resourceType: 'T', path: 'P', actual: 1 },
      ];
      expect(computeCompleteResources(['A'], findings, [])).toEqual([]);
    });

    it('#1078: an ignored-and-unrecorded value DEMOTES a previously-complete resource', () => {
      const findings: Finding[] = [
        { tier: 'ignored', logicalId: 'A', resourceType: 'T', path: 'P', actual: 1 },
      ];
      expect(computeCompleteResources(['A'], findings, [], ['A'])).toEqual([]);
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

  it('restores constructPath onto the removed-since-record finding (so a constructPath ignore rule matches)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, {
      constructPathByLogical: new Map([['A', 'MyStack/A']]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'P',
      constructPath: 'MyStack/A',
      note: 'baseline value removed since record',
    });
  });

  it('omits constructPath when the resource has none (no map entry)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, { constructPathByLogical: new Map() });
    expect(out[0]!.constructPath).toBeUndefined();
  });

  it('constructPathsByLogical maps only resources that carry a construct path', () => {
    const m = constructPathsByLogical([
      { logicalId: 'A', constructPath: 'MyStack/A' },
      { logicalId: 'B' }, // no construct path
    ]);
    expect(m.get('A')).toBe('MyStack/A');
    expect(m.has('B')).toBe(false);
  });

  it('restores physicalId onto the removed-since-record finding (so revert can act on it)', () => {
    // Without physicalId the synthesized finding reaches buildRevertPlan with no id and
    // is rejected "no physical id" — making a removed recorded value un-revertable.
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, {
      physicalIdByLogical: new Map([['A', 'phys-A']]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'P',
      physicalId: 'phys-A',
      note: 'baseline value removed since record',
    });
  });

  it('omits physicalId when the resource has no map entry', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, { physicalIdByLogical: new Map() });
    expect(out[0]!.physicalId).toBeUndefined();
  });

  it('physicalIdsByLogical maps only resources that resolved a physical id', () => {
    const m = physicalIdsByLogical([
      { logicalId: 'A', physicalId: 'phys-A' },
      { logicalId: 'B' }, // no physical id
    ]);
    expect(m.get('A')).toBe('phys-A');
    expect(m.has('B')).toBe(false);
  });

  it('does NOT report a removal for a resource SKIPPED this run (transient, not actually removed)', () => {
    // 'A' has a recorded baseline value but its read was skipped this run (CC-API gap /
    // transient error) -> gather emits a `skipped` finding. Its baseline values are
    // unread, NOT removed, so they must not flood the report as false "removed" drift.
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const skipped: Finding = {
      tier: 'skipped',
      logicalId: 'A',
      resourceType: 'AWS::X::Y',
      path: '',
    };
    const out = applyBaseline([skipped], b);
    expect(out.some((f) => f.note === 'baseline value removed since record')).toBe(false);
    // the skipped finding itself passes through untouched
    expect(out).toEqual([skipped]);
  });

  it('does NOT double-report per-property removals for a resource DELETED out of band', () => {
    // 'A' was deleted out of band -> gather emits ONE resource-level `deleted` finding,
    // which already conveys that the whole resource (and every recorded value) is gone.
    // Its recorded baseline values must NOT each re-surface as a "baseline value removed"
    // undeclared finding: that is redundant noise and inflates the drift count (1 deletion
    // would read as 1 + N drifts).
    const b = baseline([
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P1', value: ['x'] },
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P2', value: ['y'] },
    ]);
    const deleted: Finding = {
      tier: 'deleted',
      logicalId: 'A',
      resourceType: 'AWS::X::Y',
      path: '',
      note: 'resource deleted out of band',
    };
    const out = applyBaseline([deleted], b);
    expect(out.some((f) => f.note === 'baseline value removed since record')).toBe(false);
    // ONLY the single deleted finding remains — the deletion is the drift
    expect(out).toEqual([deleted]);
  });

  it('does NOT double-report a recorded nested value whose DECLARED parent is drifting', () => {
    // The declared array `Origins` drifted out of band (e.g. -> []). The recorded
    // nested undeclared value `Origins[o1].ConnectionAttempts` is gone BECAUSE the
    // parent changed — subsumed by the single `declared` Origins finding. It must NOT
    // also surface as a separate "baseline value removed" undeclared finding (double-
    // count + an un-actionable revert op against a now-gone nested path). A recorded
    // SIBLING not under the drifting parent still surfaces (precision guard).
    const b = baseline([
      {
        logicalId: 'D',
        resourceType: 'AWS::CloudFront::Distribution',
        path: 'Origins[o1].ConnectionAttempts',
        value: 5,
      },
      {
        logicalId: 'D',
        resourceType: 'AWS::CloudFront::Distribution',
        path: 'Comment',
        value: 'x',
      },
    ]);
    const declaredOrigins: Finding = {
      tier: 'declared',
      logicalId: 'D',
      resourceType: 'AWS::CloudFront::Distribution',
      path: 'Origins',
      desired: [{ id: 'o1' }],
      actual: [],
    };
    const out = applyBaseline([declaredOrigins], b);
    // the nested value UNDER the drifting Origins is suppressed
    expect(
      out.some(
        (f) =>
          f.path === 'Origins[o1].ConnectionAttempts' &&
          f.note === 'baseline value removed since record'
      )
    ).toBe(false);
    // the unrelated sibling (not under any declared drift) still surfaces as removed
    expect(
      out.some((f) => f.path === 'Comment' && f.note === 'baseline value removed since record')
    ).toBe(true);
    // the declared Origins finding passes through untouched
    expect(out.some((f) => f.tier === 'declared' && f.path === 'Origins')).toBe(true);
  });

  it('does NOT report a removal when the recorded path was promoted into the template', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['A', { P: ['x'] }]]), // P is now declared
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0); // no false "removed" finding
    expect(warnings[0]).toContain('now declared in the template');
  });

  it('R134: folds MANY promoted-stale entries into ONE warn line (not one per entry)', () => {
    // three recorded paths, all since declared in the template → previously 3 notes
    const b = baseline([
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P1', value: ['x'] },
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P2', value: ['y'] },
      { logicalId: 'B', resourceType: 'AWS::X::Y', path: 'Q', value: ['z'] },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map<string, Record<string, unknown>>([
        ['A', { P1: ['x'], P2: ['y'] }],
        ['B', { Q: ['z'] }],
      ]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0);
    expect(warnings).toHaveLength(1); // ONE folded line, not three
    expect(warnings[0]).toContain('3 baseline entries are now declared in the template');
    expect(warnings[0]).toContain('re-run `cdkrd record`');
  });

  describe('formatPromotedStaleNote (R134 — folded one-liner)', () => {
    it('singular names the one entry', () => {
      const note = formatPromotedStaleNote(['A.P']);
      expect(note).toBe(
        'note: baseline entry (A.P) is now declared in the template — re-run `cdkrd record` to clean it up.'
      );
    });
    it('plural folds to a count (no per-entry list)', () => {
      const note = formatPromotedStaleNote(['A.P1', 'A.P2', 'B.Q']);
      expect(note).toContain('3 baseline entries are now declared');
      expect(note).toContain('clean them up');
      expect(note).not.toContain('A.P1'); // folded — individual paths not listed
    });
  });

  it('still reports a removal when the recorded path is genuinely gone (not declared)', () => {
    const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['A', { Other: true }]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ note: 'baseline value removed since record' });
  });

  describe('#675 — resource REMOVED from the template (baseline entries folded, not phantom drift)', () => {
    it('folds a recorded entry whose logicalId is absent from the current template', () => {
      // 'A' was removed from the template and deleted by the deploy. It is in neither the
      // template nor live AWS — its recorded entry must not surface as "removed since record".
      const b = baseline([
        { logicalId: 'A', resourceType: 'AWS::S3::Bucket', path: 'P', value: ['x'] },
      ]);
      const warnings: string[] = [];
      const out = applyBaseline([], b, {
        allLogicalIds: ['B', 'C'], // 'A' gone from the template
        warn: (m) => warnings.push(m),
      });
      expect(out).toHaveLength(0); // never surfaced as drift
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('no longer in the template');
      expect(warnings[0]).toContain('re-run `cdkrd record`');
    });

    it('folds MANY removed-from-template entries into ONE warn line', () => {
      const b = baseline([
        { logicalId: 'A', resourceType: 'AWS::S3::Bucket', path: 'P1', value: 1 },
        { logicalId: 'A', resourceType: 'AWS::S3::Bucket', path: 'P2', value: 2 },
      ]);
      const warnings: string[] = [];
      const out = applyBaseline([], b, { allLogicalIds: ['Other'], warn: (m) => warnings.push(m) });
      expect(out).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        '2 baseline entries belong to resources no longer in the template'
      );
    });

    it('a still-present logicalId behaves as before (genuine removal still surfaces)', () => {
      // 'A' is STILL in the template, so a recorded path now absent is a genuine removal.
      const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
      const out = applyBaseline([], b, { allLogicalIds: ['A'] });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ note: 'baseline value removed since record' });
    });

    it('with NO allLogicalIds passed, keeps today’s behavior (surfaces the removal)', () => {
      const b = baseline([{ logicalId: 'A', resourceType: 'AWS::X::Y', path: 'P', value: ['x'] }]);
      const out = applyBaseline([], b); // no allLogicalIds
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ note: 'baseline value removed since record' });
    });
  });

  describe('#674 — resource REPLACED by a deploy (stale entries voided when live physId differs)', () => {
    const atDef = (logicalId: string, path: string, value: unknown): Finding => ({
      tier: 'atDefault',
      logicalId,
      resourceType: 'AWS::SQS::Queue',
      path,
      actual: value,
    });
    // helper: a baseline carrying a recorded physical id for the logicalId
    const withPhys = (
      recorded: BaselineFile['recorded'],
      recordedPhysicalIds: Record<string, string>
    ): BaselineFile => ({ ...baseline(recorded), recordedPhysicalIds });

    it('voids a changed-from-baseline entry when the live physical id DIFFERS (replacement)', () => {
      // Recorded VisibilityTimeout=120 against the OLD queue (phys-old). The new (replaced)
      // queue reads the fresh AWS default 30 (atDefault). Without the fix this surfaces as
      // "changed from your .cdkrd baseline" drift; the recorded 120 belongs to a deleted queue.
      const b = withPhys(
        [
          {
            logicalId: 'Q',
            resourceType: 'AWS::SQS::Queue',
            path: 'VisibilityTimeout',
            value: 120,
          },
        ],
        { Q: 'phys-old' }
      );
      const warnings: string[] = [];
      const out = applyBaseline([atDef('Q', 'VisibilityTimeout', 30)], b, {
        physicalIdByLogical: new Map([['Q', 'phys-new']]),
        warn: (m) => warnings.push(m),
      });
      // the fresh default folds (atDefault passes through as folded inventory, not drift)
      expect(out.some((f) => f.tier === 'undeclared')).toBe(false);
      // and a folded nudge is emitted
      expect(warnings.some((w) => w.includes('since REPLACED by a deploy'))).toBe(true);
    });

    it('does NOT surface a "removed since record" finding for a replaced resource', () => {
      // The recorded path is gone from the (new) resource's findings — but because the
      // resource was replaced, it is void, not "removed since record".
      const b = withPhys(
        [
          {
            logicalId: 'Q',
            resourceType: 'AWS::SQS::Queue',
            path: 'VisibilityTimeout',
            value: 120,
          },
        ],
        { Q: 'phys-old' }
      );
      const warnings: string[] = [];
      const out = applyBaseline([], b, {
        physicalIdByLogical: new Map([['Q', 'phys-new']]),
        warn: (m) => warnings.push(m),
      });
      expect(out.some((f) => f.note === 'baseline value removed since record')).toBe(false);
      expect(warnings.some((w) => w.includes('since REPLACED by a deploy'))).toBe(true);
    });

    it('a MATCHING physical id behaves as before (recorded value still compared → drift)', () => {
      // Same physical id -> not replaced. A changed live value is real drift.
      const b = withPhys(
        [
          {
            logicalId: 'Q',
            resourceType: 'AWS::SQS::Queue',
            path: 'VisibilityTimeout',
            value: 120,
          },
        ],
        { Q: 'phys-same' }
      );
      const out = applyBaseline([atDef('Q', 'VisibilityTimeout', 30)], b, {
        physicalIdByLogical: new Map([['Q', 'phys-same']]),
      });
      // recorded 120 vs live 30 -> surfaces as drift (forced to undeclared)
      expect(out.some((f) => f.tier === 'undeclared' && f.path === 'VisibilityTimeout')).toBe(true);
    });

    it('a MISSING recorded physical id (old baseline) falls back to today’s behavior (no void)', () => {
      // Old committed baseline: no recordedPhysicalIds. Even if the live id "differs", there
      // is nothing to compare, so the recorded value is compared as usual (→ drift).
      const b = baseline([
        { logicalId: 'Q', resourceType: 'AWS::SQS::Queue', path: 'VisibilityTimeout', value: 120 },
      ]);
      const out = applyBaseline([atDef('Q', 'VisibilityTimeout', 30)], b, {
        physicalIdByLogical: new Map([['Q', 'phys-new']]),
      });
      expect(out.some((f) => f.tier === 'undeclared' && f.path === 'VisibilityTimeout')).toBe(true);
    });

    it('an UNKNOWN live physical id (unread this run) does NOT void — fall back to today’s behavior', () => {
      const b = withPhys(
        [
          {
            logicalId: 'Q',
            resourceType: 'AWS::SQS::Queue',
            path: 'VisibilityTimeout',
            value: 120,
          },
        ],
        { Q: 'phys-old' }
      );
      const out = applyBaseline([atDef('Q', 'VisibilityTimeout', 30)], b, {
        physicalIdByLogical: new Map(), // no live id resolved
      });
      expect(out.some((f) => f.tier === 'undeclared' && f.path === 'VisibilityTimeout')).toBe(true);
    });
  });

  describe('formatRemovedFromTemplateNote (#675 — folded one-liner)', () => {
    it('singular names the one entry', () => {
      expect(formatRemovedFromTemplateNote(['A.P'])).toBe(
        'note: baseline entry (A.P) belongs to resources no longer in the template — re-run `cdkrd record` to clean them up.'
      );
    });
    it('plural folds to a count (no per-entry list)', () => {
      const note = formatRemovedFromTemplateNote(['A.P1', 'A.P2', 'B.Q']);
      expect(note).toContain('3 baseline entries belong to resources no longer in the template');
      expect(note).not.toContain('A.P1');
    });
  });

  describe('formatReplacedStaleNote (#674 — folded one-liner)', () => {
    it('singular names the one entry', () => {
      expect(formatReplacedStaleNote(['Q.VisibilityTimeout'])).toBe(
        'note: baseline entry (Q.VisibilityTimeout) was recorded against a resource since REPLACED by a deploy — re-run `cdkrd record`.'
      );
    });
    it('plural folds to a count (no per-entry list)', () => {
      const note = formatReplacedStaleNote(['Q.A', 'Q.B']);
      expect(note).toContain('2 baseline entries were recorded against a resource since REPLACED');
      expect(note).not.toContain('Q.A');
    });
  });

  describe('writeBaseline captures recordedPhysicalIds (#674)', () => {
    it('stores per-resource physical id, pruned to logicalIds with an entry, sorted', () => {
      const recorded: BaselineFile['recorded'] = [
        { logicalId: 'Q', resourceType: 'AWS::SQS::Queue', path: 'VisibilityTimeout', value: 30 },
      ];
      // exercise sortedPhysicalIds directly via writeBaselineFile to keep this pure (no fs
      // in this assertion; the round-trip fs test lives in the writeBaselineFile block).
      const file: BaselineFile = {
        ...baseline(recorded),
        schemaVersion: 2,
        recordedPhysicalIds: { Z: 'phys-Z-noentry', Q: 'phys-Q' },
      };
      // sortedPhysicalIds is internal; assert its effect through a fs round-trip.
      return (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'cdkrd-phys-'));
        const cwd = process.cwd();
        process.chdir(dir);
        try {
          const p = await writeBaselineFile(file);
          const reread = JSON.parse(await readFile(p, 'utf8')) as BaselineFile;
          // 'Z' has no recorded entry -> pruned; only 'Q' remains
          expect(reread.recordedPhysicalIds).toEqual({ Q: 'phys-Q' });
        } finally {
          process.chdir(cwd);
          await rm(dir, { recursive: true, force: true });
        }
      })();
    });
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

  describe('loadBaseline fail-safe validation (WAVE23 — a malformed/newer baseline errors clearly)', () => {
    const withBaselineFile = async (contents: string, fn: () => Promise<void>) => {
      const dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const p = baselinePath('s', '111122223333', 'r');
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, contents, 'utf8');
        await fn();
      } finally {
        process.chdir(cwd);
        await rm(dir, { recursive: true, force: true });
      }
    };

    it('throws a CLEAR error on corrupt JSON (not an opaque SyntaxError)', async () => {
      await withBaselineFile('{ "recorded": [', async () => {
        await expect(loadBaseline('s', '111122223333', 'r')).rejects.toThrow(/not valid JSON/);
      });
    });

    it('throws when `recorded` is missing/not an array (not a later opaque TypeError)', async () => {
      await withBaselineFile(JSON.stringify({ schemaVersion: 2, stackName: 's' }), async () => {
        await expect(loadBaseline('s', '111122223333', 'r')).rejects.toThrow(
          /`recorded` is missing or not an array/
        );
      });
    });

    it('throws on a newer schemaVersion (a future cdkrd wrote it) instead of mis-applying as v2', async () => {
      await withBaselineFile(JSON.stringify({ schemaVersion: 3, recorded: [] }), async () => {
        await expect(loadBaseline('s', '111122223333', 'r')).rejects.toThrow(/newer cdkrd/);
      });
    });

    it('#870: throws on a NON-NUMBER schemaVersion (a string "3" bypasses the > 2 future-guard)', async () => {
      // A merge-damaged / hand-edited string version must not slip past `typeof === number`
      // and be silently treated as ≤ v2.
      await withBaselineFile(
        JSON.stringify({ schemaVersion: '3', recorded: [], stackName: 's' }),
        async () => {
          await expect(loadBaseline('s', '111122223333', 'r')).rejects.toThrow(
            /non-numeric schemaVersion/
          );
        }
      );
    });

    it('#870: throws when the stored stackName disagrees with the loaded path (wrong-stack / case-collision)', async () => {
      // The file lives at the path for stack `s`, but its stored stackName is another
      // stack — a hand-copy / rename, or a case-insensitive-FS collision (MyStack vs mystack).
      await withBaselineFile(
        JSON.stringify({ schemaVersion: 2, recorded: [], stackName: 'OtherStack', region: 'r' }),
        async () => {
          await expect(loadBaseline('s', '111122223333', 'r')).rejects.toThrow(
            /captured for stack OtherStack.*loaded as stack s/s
          );
        }
      );
    });

    it('#870: throws when the stored region disagrees with the loaded path', async () => {
      await withBaselineFile(
        JSON.stringify({ schemaVersion: 2, recorded: [], stackName: 's', region: 'other-region' }),
        async () => {
          await expect(loadBaseline('s', '111122223333', 'r')).rejects.toThrow(
            /captured in region other-region.*current region is r/s
          );
        }
      );
    });

    it('#870: tolerates an older/partial file with no stackName/region (next record stamps it)', async () => {
      await withBaselineFile(JSON.stringify({ schemaVersion: 2, recorded: [] }), async () => {
        expect((await loadBaseline('s', '111122223333', 'r'))?.recorded).toEqual([]);
      });
    });

    it('still loads a valid v1/v2 baseline (no false rejection)', async () => {
      await withBaselineFile(
        JSON.stringify({ schemaVersion: 2, recorded: [], stackName: 's' }),
        async () => {
          expect((await loadBaseline('s', '111122223333', 'r'))?.recorded).toEqual([]);
        }
      );
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

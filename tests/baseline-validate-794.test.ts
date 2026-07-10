// #794: loadBaseline element-level validation — a hand-edited / merge-conflicted baseline
// (git-committed, so it CAN be malformed) must fail LOUDLY naming the file + the offending
// index/key, not crash opaquely deep in applyBaseline or silently disable completeness.
//
// #793: a logicalId reused for a DIFFERENT resource type must void the old-type baseline
// entries — never suppress/surface against the new type, never emit a "removed since record"
// finding pairing the OLD resourceType with the new resource's live physical id.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { type BaselineFile, baselinePath, loadBaseline } from '../src/baseline/baseline-file.js';

const ACCOUNT = '111122223333';
const REGION = 'r';
const STACK = 's';

// Write a raw JSON string to the baseline path loadBaseline() reads, then load it.
async function loadRaw(rawJson: string): Promise<BaselineFile | undefined> {
  const p = baselinePath(STACK, ACCOUNT, REGION);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, rawJson, 'utf8');
  return loadBaseline(STACK, ACCOUNT, REGION);
}

describe('#794 loadBaseline element-level validation', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-794-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const base = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 2,
      stackName: STACK,
      region: REGION,
      accountId: ACCOUNT,
      capturedAt: '',
      templateHash: '',
      recorded: [],
      ...extra,
    });

  it('a null element in `recorded` throws, naming the file + index', async () => {
    await expect(loadRaw(base({ recorded: [null] }))).rejects.toThrow(
      /baseline file .*`recorded`\[0\] must be an object/
    );
  });

  it('a `recorded` element missing a string logicalId throws, naming the file + key', async () => {
    await expect(
      loadRaw(base({ recorded: [{ resourceType: 'AWS::X::Y', path: 'P', value: 1 }] }))
    ).rejects.toThrow(
      /baseline file .*`recorded`\[0\]: "logicalId" is required and must be a string/
    );
  });

  it('a `recorded` element with a non-string resourceType throws', async () => {
    await expect(
      loadRaw(base({ recorded: [{ logicalId: 'L', resourceType: 42, path: 'P', value: 1 }] }))
    ).rejects.toThrow(/`recorded`\[0\]: "resourceType" is required and must be a string/);
  });

  it('a scalar (non-object) `recorded` element throws', async () => {
    await expect(loadRaw(base({ recorded: ['MyRes'] }))).rejects.toThrow(
      /`recorded`\[0\] must be an object/
    );
  });

  it('completeResources as a bare string throws (would silently iterate CHARACTERS)', async () => {
    await expect(loadRaw(base({ completeResources: 'MyRes' }))).rejects.toThrow(
      /baseline file .*`completeResources` must be an array of strings/
    );
  });

  it('completeResources as a number throws (opaque "not iterable" otherwise)', async () => {
    await expect(loadRaw(base({ completeResources: 42 }))).rejects.toThrow(
      /`completeResources` must be an array of strings/
    );
  });

  it('completeResources with a non-string element throws, naming the index', async () => {
    await expect(loadRaw(base({ completeResources: ['ok', 5] }))).rejects.toThrow(
      /`completeResources`\[1\] must be a string/
    );
  });

  it('recordedPhysicalIds as an array throws', async () => {
    await expect(loadRaw(base({ recordedPhysicalIds: ['x'] }))).rejects.toThrow(
      /`recordedPhysicalIds` must be an object mapping logicalId to physical id/
    );
  });

  it('recordedPhysicalIds with a non-string value throws, naming the key', async () => {
    await expect(loadRaw(base({ recordedPhysicalIds: { L: 123 } }))).rejects.toThrow(
      /`recordedPhysicalIds`: "L" must map to a string/
    );
  });

  it('a well-formed baseline still loads', async () => {
    const loaded = await loadRaw(
      base({
        recorded: [{ logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P', value: 1 }],
        completeResources: ['L'],
        recordedPhysicalIds: { L: 'phys-1' },
      })
    );
    expect(loaded?.recorded).toHaveLength(1);
    expect(loaded?.completeResources).toEqual(['L']);
    expect(loaded?.recordedPhysicalIds).toEqual({ L: 'phys-1' });
  });

  it('a v1 baseline (no completeResources / recordedPhysicalIds) still loads', async () => {
    const loaded = await loadRaw(
      base({ recorded: [{ logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P', value: 1 }] })
    );
    expect(loaded?.recorded).toHaveLength(1);
  });
});

// #1047: two `recorded` entries sharing the SAME (logicalId, path, resourceType) identity but
// DIFFERENT values (a bad merge / hand-edit) must be REJECTED LOUDLY at load — the match sites
// (`recorded.find`) silently first-win, so a live value equal to the SECOND duplicate would
// false-surface as drift, and the removed-since-record loop would double-count. Fail rather
// than silently pick the first.
describe('#1047 loadBaseline duplicate-identity rejection', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-1047-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const base = (recorded: unknown[]): string =>
    JSON.stringify({
      schemaVersion: 2,
      stackName: STACK,
      region: REGION,
      accountId: ACCOUNT,
      capturedAt: '',
      templateHash: '',
      recorded,
    });

  it('two entries with the same identity but different values are rejected, naming the identity', async () => {
    await expect(
      loadRaw(
        base([
          { logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P', value: 1 },
          { logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P', value: 2 },
        ])
      )
    ).rejects.toThrow(
      /baseline file .*`recorded`\[1\] is a duplicate of an earlier entry with the same identity \(logicalId="L", path="P", resourceType="AWS::X::Y"\)/
    );
  });

  it('two entries with the same identity and IDENTICAL values are still rejected (still ambiguous / corrupt)', async () => {
    await expect(
      loadRaw(
        base([
          { logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P', value: 1 },
          { logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P', value: 1 },
        ])
      )
    ).rejects.toThrow(/`recorded`\[1\] is a duplicate of an earlier entry/);
  });

  it('same logicalId+resourceType but DIFFERENT path still loads (distinct identities)', async () => {
    const loaded = await loadRaw(
      base([
        { logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P1', value: 1 },
        { logicalId: 'L', resourceType: 'AWS::X::Y', path: 'P2', value: 2 },
      ])
    );
    expect(loaded?.recorded).toHaveLength(2);
  });

  it('same logicalId+path but DIFFERENT resourceType still loads (id recycled across a refactor, #793)', async () => {
    const loaded = await loadRaw(
      base([
        { logicalId: 'L', resourceType: 'AWS::SQS::Queue', path: 'P', value: 1 },
        { logicalId: 'L', resourceType: 'AWS::SNS::Topic', path: 'P', value: 2 },
      ])
    );
    expect(loaded?.recorded).toHaveLength(2);
  });

  it('two `added` entries (empty path) for DIFFERENT child logicalIds still load', async () => {
    const loaded = await loadRaw(
      base([
        { logicalId: 'ChildA', resourceType: 'AWS::ApiGateway::Stage', path: '', value: {} },
        { logicalId: 'ChildB', resourceType: 'AWS::ApiGateway::Stage', path: '', value: {} },
      ])
    );
    expect(loaded?.recorded).toHaveLength(2);
  });
});

// #1048: a baseline is a git-committed, hand-editable artifact, so a typo'd key must fail
// LOUDLY (like config-file.ts) rather than silently disable detection — a top-level typo
// (`completeResource`/`recordedPhysicalId`) turns a whole mechanism off, a per-entry typo
// (`Value`) drops the value to recorded `undefined` = a confirmed-drift false positive.
describe('#1048 loadBaseline unknown-key rejection', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-1048-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const base = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 2,
      stackName: STACK,
      region: REGION,
      accountId: ACCOUNT,
      capturedAt: '',
      templateHash: '',
      recorded: [],
      ...extra,
    });

  it('an unknown TOP-LEVEL key throws, naming the offender (completeResource typo)', async () => {
    await expect(loadRaw(base({ completeResource: ['Res'] }))).rejects.toThrow(
      /baseline file .*unknown key\(s\) "completeResource"/
    );
  });

  it('a recordedPhysicalId (missing s) typo throws instead of silently disabling #674 voiding', async () => {
    await expect(loadRaw(base({ recordedPhysicalId: { Res: 'phys' } }))).rejects.toThrow(
      /unknown key\(s\) "recordedPhysicalId"/
    );
  });

  it('all known optional keys ABSENT still loads (old file — only PRESENT strangers rejected)', async () => {
    const loaded = await loadRaw(base({}));
    expect(loaded?.recorded).toEqual([]);
  });

  it('an unknown PER-ENTRY key throws (a capital-V `Value` typo)', async () => {
    await expect(
      loadRaw(
        base({
          recorded: [{ logicalId: 'L', resourceType: 'AWS::S3::Bucket', path: 'P', Value: 'v1' }],
        })
      )
    ).rejects.toThrow(/`recorded`\[0\]: unknown key\(s\) "Value"/);
  });

  it('a per-entry with `value` ABSENT throws (undefined-by-absence is indistinguishable from a typo)', async () => {
    await expect(
      loadRaw(base({ recorded: [{ logicalId: 'L', resourceType: 'AWS::S3::Bucket', path: 'P' }] }))
    ).rejects.toThrow(/`recorded`\[0\]: "value" is required/);
  });

  it('an intentional recorded null value is accepted (value PRESENT as null)', async () => {
    const loaded = await loadRaw(
      base({
        recorded: [{ logicalId: 'L', resourceType: 'AWS::S3::Bucket', path: 'P', value: null }],
      })
    );
    expect(loaded?.recorded).toEqual([
      { logicalId: 'L', resourceType: 'AWS::S3::Bucket', path: 'P', value: null },
    ]);
  });
});

// #1137: loadBaseline JSON.parse diagnostics (the deferred JSON half of #1049). A corrupt /
// merge-conflicted baseline must surface JSON.parse's position + a conflict/recovery hint, not
// a bare "is not valid JSON".
describe('#1137 loadBaseline JSON.parse diagnostics', () => {
  let cwd: string;
  let dir: string;
  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-baseline-1137-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('an unresolved git merge-conflict marker surfaces the conflict hint + JSON.parse detail', async () => {
    const raw =
      '{\n<<<<<<< HEAD\n  "schemaVersion": 2,\n=======\n  "schemaVersion": 3,\n>>>>>>> branch\n}\n';
    await expect(loadRaw(raw)).rejects.toThrow(/unresolved git merge conflict/);
    // and it still carries JSON.parse's own diagnostic (not just the bare message)
    await expect(loadRaw(raw)).rejects.toThrow(/is not valid JSON.*:/);
  });

  it('a trailing-comma corruption surfaces JSON.parse position + recovery hint', async () => {
    const raw = '{ "schemaVersion": 2, "recorded": [], }';
    await expect(loadRaw(raw)).rejects.toThrow(
      /is not valid JSON \(corrupt or partially written\): .+/
    );
    await expect(loadRaw(raw)).rejects.toThrow(/git restore/);
  });
});

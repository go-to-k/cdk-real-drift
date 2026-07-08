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

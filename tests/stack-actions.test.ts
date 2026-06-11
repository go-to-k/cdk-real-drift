import { describe, expect, it } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { availableActions, resolveInteractiveRevertExit } from '../src/commands/stack-actions.js';
import type { Finding, SchemaInfo } from '../src/types.js';

const NO_SCHEMAS = new Map<string, SchemaInfo>();

const declared = (): Finding => ({
  tier: 'declared',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration',
  physicalId: 'b-phys',
  desired: { Status: 'Enabled' },
  actual: { Status: 'Suspended' },
});
const undeclared = (): Finding => ({
  tier: 'undeclared',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: 'AccelerateConfiguration',
  physicalId: 'b-phys',
  actual: { AccelerationStatus: 'Enabled' },
});
const deleted = (): Finding => ({
  tier: 'deleted',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: '',
  physicalId: 'b-phys',
});

const blessed = (entries: BaselineFile['accepted']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  accepted: entries,
});

describe('availableActions (R28 interactive choice logic)', () => {
  it('declared-only → Accept hidden (cannot bless declared), Revert shown', () => {
    expect(availableActions([declared()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: false,
      revert: true,
    });
  });

  it('undeclared-only with NO baseline → Accept shown, Revert hidden (no-baseline guard)', () => {
    expect(availableActions([undeclared()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: true,
      revert: false,
    });
  });

  it('undeclared-only with --remove-unblessed → Revert becomes available', () => {
    expect(availableActions([undeclared()], undefined, NO_SCHEMAS, true)).toEqual({
      accept: true,
      revert: true,
    });
  });

  it('deleted-only → neither (deleted is not revertable, nothing to bless)', () => {
    expect(availableActions([deleted()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: false,
      revert: false,
    });
  });

  it('mixed declared + undeclared (with baseline making undeclared revertable) → both', () => {
    const b = blessed([
      {
        logicalId: 'B',
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        value: { AccelerationStatus: 'Suspended' },
      },
    ]);
    // undeclared is blessed-then-changed → revertable to the blessed value; declared → revertable
    expect(availableActions([declared(), undeclared()], b, NO_SCHEMAS, false)).toEqual({
      accept: true,
      revert: true,
    });
  });
});

describe('resolveInteractiveRevertExit (R30 — abort must not drop drift to exit 0)', () => {
  it('aborted confirm → keep the pre-revert code (drift still stands)', () => {
    // check is always in the drift branch (code 1) when it reaches revert
    expect(resolveInteractiveRevertExit(1, { exit: 0, aborted: true })).toBe(1);
  });

  it('revert applied & converged → adopt the outcome exit (0 clean)', () => {
    expect(resolveInteractiveRevertExit(1, { exit: 0, aborted: false })).toBe(0);
  });

  it('revert applied but drift remains → adopt exit 1', () => {
    expect(resolveInteractiveRevertExit(1, { exit: 1, aborted: false })).toBe(1);
  });

  it('revert apply failure → adopt exit 2', () => {
    expect(resolveInteractiveRevertExit(1, { exit: 2, aborted: false })).toBe(2);
  });
});

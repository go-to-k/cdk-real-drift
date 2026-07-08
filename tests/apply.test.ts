import {
  CloudControlClient,
  DeleteResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  type ApplyResult,
  applyRevertDelete,
  applyRevertDeletes,
  applyRevertItem,
  isAlreadyGone,
} from '../src/revert/apply.js';
import type { RevertItem } from '../src/revert/plan.js';

const cc = mockClient(CloudControlClient);
beforeEach(() => cc.reset());

// No real backoff waiting in tests.
const noNap = { sleep: () => Promise.resolve() };

const deleteItem = (): RevertItem => ({
  logicalId: 'Child',
  displayId: 'Api ▸ ANY /a',
  resourceType: 'AWS::ApiGateway::Method',
  physicalId: 'api123|res456|ANY',
  kind: 'delete',
  ops: [],
});

const updateItem = (): RevertItem => ({
  logicalId: 'RR',
  displayId: 'Stack/ResolverRule',
  resourceType: 'AWS::Route53Resolver::ResolverRule',
  physicalId: 'rslvr-rr-abc',
  kind: 'cc',
  ops: [
    { op: 'add', path: '/DomainName', value: 'example.internal.', human: 'DomainName -> default' },
  ],
});

const RSLVR_UPDATING = "[RSLVR-00705] Cannot update Resolver Rule because it's currently updating.";

describe('isAlreadyGone', () => {
  it('true for not-found error names', () => {
    expect(isAlreadyGone({ name: 'ResourceNotFoundException' })).toBe(true);
    expect(isAlreadyGone({ name: 'NotFoundException' })).toBe(true);
  });
  it('true for not-found messages (case-insensitive, various phrasings)', () => {
    expect(isAlreadyGone({ message: 'Resource was not found' })).toBe(true);
    expect(isAlreadyGone({ message: 'The resource does not exist' })).toBe(true);
    expect(isAlreadyGone({ message: 'NotFound' })).toBe(true);
  });
  it('false for unrelated errors', () => {
    expect(isAlreadyGone({ name: 'AccessDeniedException', message: 'not authorized' })).toBe(false);
    expect(isAlreadyGone({})).toBe(false);
    expect(isAlreadyGone({ message: 'throttled' })).toBe(false);
  });
});

describe('applyRevertDelete — already-gone tolerance', () => {
  it('treats a thrown ResourceNotFoundException as SUCCESS (cascade/manual delete race)', async () => {
    const e = new Error('Resource of type AWS::ApiGateway::Method with id ... was not found');
    e.name = 'ResourceNotFoundException';
    cc.on(DeleteResourceCommand).rejects(e);
    expect(await applyRevertDelete(cc as unknown as CloudControlClient, deleteItem())).toEqual({
      ok: true,
    });
  });

  it('still FAILS on a genuine error', async () => {
    const e = new Error('not authorized to perform cloudcontrolapi:DeleteResource');
    e.name = 'AccessDeniedException';
    cc.on(DeleteResourceCommand).rejects(e);
    const r = await applyRevertDelete(cc as unknown as CloudControlClient, deleteItem());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not authorized');
  });
});

describe('applyRevertItem — transient retry then hint (issue #467)', () => {
  it('retries an RSLVR-00705 mid-update FAILED event and succeeds on a later attempt', async () => {
    cc.on(UpdateResourceCommand)
      .resolvesOnce({
        ProgressEvent: {
          RequestToken: 't1',
          OperationStatus: 'FAILED',
          StatusMessage: RSLVR_UPDATING,
        },
      })
      .resolves({ ProgressEvent: { RequestToken: 't2', OperationStatus: 'SUCCESS' } });
    const r = await applyRevertItem(
      cc as unknown as CloudControlClient,
      updateItem(),
      undefined,
      noNap
    );
    expect(r.ok).toBe(true);
    expect(cc.commandCalls(UpdateResourceCommand).length).toBe(2);
  });

  it('exhausts retries on a persistent mid-update failure and returns a transient hint', async () => {
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: {
        RequestToken: 't1',
        OperationStatus: 'FAILED',
        StatusMessage: RSLVR_UPDATING,
      },
    });
    const r = await applyRevertItem(cc as unknown as CloudControlClient, updateItem(), undefined, {
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });
    expect(r.ok).toBe(false);
    expect(r.transient).toBe(true);
    expect(r.hint).toContain('async propagation');
    expect(cc.commandCalls(UpdateResourceCommand).length).toBe(3);
  });

  it('does NOT retry a terminal ValidationException (fails on first attempt)', async () => {
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: {
        RequestToken: 't1',
        OperationStatus: 'FAILED',
        StatusMessage: 'Invalid property DomainName',
        ErrorCode: 'InvalidRequest',
      },
    });
    const r = await applyRevertItem(
      cc as unknown as CloudControlClient,
      updateItem(),
      undefined,
      noNap
    );
    expect(r.ok).toBe(false);
    expect(r.transient).toBeUndefined();
    expect(cc.commandCalls(UpdateResourceCommand).length).toBe(1);
  });

  it('surfaces the Cloud Control ErrorCode alongside the message for classification', async () => {
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: {
        RequestToken: 't1',
        OperationStatus: 'FAILED',
        StatusMessage: 'Rate exceeded',
        ErrorCode: 'Throttling',
      },
    });
    const r = await applyRevertItem(cc as unknown as CloudControlClient, updateItem(), undefined, {
      maxAttempts: 2,
      sleep: () => Promise.resolve(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Throttling');
    expect(r.transient).toBe(true);
  });
});

describe('applyRevertDeletes — dependency-aware batch retry (issue #765)', () => {
  const DEP_VIOLATION = 'DependencyViolation: resource is still referenced by another resource';

  // A: fails on the FIRST attempt (its dependency B not yet gone), succeeds on retry.
  // B: succeeds immediately. After B is deleted, retrying A converges.
  it('retries a DependencyViolation-failed delete once its dependency is deleted', async () => {
    let aAttempts = 0;
    const applyOne = (id: string): Promise<ApplyResult> => {
      if (id === 'A') {
        aAttempts++;
        // Fail A once (B not yet deleted), then succeed on the retry pass.
        return Promise.resolve(
          aAttempts === 1 ? { ok: false, error: DEP_VIOLATION } : { ok: true }
        );
      }
      return Promise.resolve({ ok: true }); // B deletes cleanly
    };

    const outcomes = await applyRevertDeletes(['A', 'B'], applyOne);

    // The batch converges — no still-failed deletes.
    expect(outcomes.every((o) => o.result.ok)).toBe(true);
    expect(outcomes.map((o) => o.item)).toEqual(['A', 'B']); // input order preserved
    expect(aAttempts).toBe(2); // A retried exactly once after B freed it
  });

  it('a SINGLE pass (no retry) would leave A failed — proving the retry is load-bearing', async () => {
    // Same fail-A-once thunk, but drive ONE pass by hand (what the pre-fix inline loop did).
    let aAttempts = 0;
    const applyOne = (id: string): Promise<ApplyResult> => {
      if (id === 'A') {
        aAttempts++;
        return Promise.resolve(
          aAttempts === 1 ? { ok: false, error: DEP_VIOLATION } : { ok: true }
        );
      }
      return Promise.resolve({ ok: true });
    };
    const firstPass = [
      { item: 'A', result: await applyOne('A') },
      { item: 'B', result: await applyOne('B') },
    ];
    // Without a retry pass A stays failed even though B is now gone.
    expect(firstPass.find((o) => o.item === 'A')?.result.ok).toBe(false);
  });

  it('a genuinely-stuck delete (never succeeds) stops after a no-progress pass', async () => {
    let calls = 0;
    const applyOne = (id: string): Promise<ApplyResult> => {
      calls++;
      // A always fails; B succeeds. First pass clears B (progress), so ONE retry pass runs
      // over A only; that pass clears nothing → no-progress break. A remains failed.
      return Promise.resolve(id === 'B' ? { ok: true } : { ok: false, error: DEP_VIOLATION });
    };
    const outcomes = await applyRevertDeletes(['A', 'B'], applyOne);
    expect(outcomes.find((o) => o.item === 'A')?.result.ok).toBe(false);
    expect(outcomes.find((o) => o.item === 'B')?.result.ok).toBe(true);
    // pass 1: A + B (2 calls); pass 2: A only (1 call); then no-progress break.
    expect(calls).toBe(3);
  });

  it('single pass when everything succeeds (identical to inline behavior)', async () => {
    let calls = 0;
    const outcomes = await applyRevertDeletes(['A', 'B', 'C'], () => {
      calls++;
      return Promise.resolve({ ok: true });
    });
    expect(outcomes.every((o) => o.result.ok)).toBe(true);
    expect(calls).toBe(3); // exactly one attempt per item — no extra passes
  });
});

describe('applyRevertDelete — transient retry', () => {
  it('retries a mid-update DeleteResource failure and succeeds', async () => {
    cc.on(DeleteResourceCommand)
      .resolvesOnce({
        ProgressEvent: {
          RequestToken: 't1',
          OperationStatus: 'FAILED',
          StatusMessage: 'ConcurrentModificationException: another operation is in progress',
        },
      })
      .resolves({ ProgressEvent: { RequestToken: 't2', OperationStatus: 'SUCCESS' } });
    const r = await applyRevertDelete(
      cc as unknown as CloudControlClient,
      deleteItem(),
      undefined,
      noNap
    );
    expect(r.ok).toBe(true);
    expect(cc.commandCalls(DeleteResourceCommand).length).toBe(2);
  });
});

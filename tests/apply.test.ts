import {
  CloudControlClient,
  DeleteResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { applyRevertDelete, applyRevertItem, isAlreadyGone } from '../src/revert/apply.js';
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

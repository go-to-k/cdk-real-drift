import { CloudControlClient, DeleteResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { applyRevertDelete, isAlreadyGone } from '../src/revert/apply.js';
import type { RevertItem } from '../src/revert/plan.js';

const cc = mockClient(CloudControlClient);
beforeEach(() => cc.reset());

const deleteItem = (): RevertItem => ({
  logicalId: 'Child',
  displayId: 'Api ▸ ANY /a',
  resourceType: 'AWS::ApiGateway::Method',
  physicalId: 'api123|res456|ANY',
  kind: 'delete',
  ops: [],
});

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

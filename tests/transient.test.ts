import { describe, expect, it } from 'vite-plus/test';
import {
  classifyTransient,
  errorText,
  type RetryableResult,
  retryTransient,
} from '../src/revert/transient.js';

describe('classifyTransient — transient (retry-later) error class', () => {
  it('classifies the Route53Resolver mid-update code (issue #467)', () => {
    const v = classifyTransient(
      "[RSLVR-00705] Cannot update Resolver Rule because it's currently updating."
    );
    expect(v.transient).toBe(true);
    expect(v.hint).toContain('async propagation');
  });

  it('classifies generic concurrent-modification / in-progress errors', () => {
    for (const msg of [
      'ConcurrentModificationException: Cannot update while a change is applied',
      'OperationInProgressException: try again',
      'ResourceConflictException: The operation cannot be performed',
      'ConflictException: resource is being modified',
      'Another operation is currently in progress for this resource',
      'An update is in progress; please try again',
      'The resource is currently being updated',
      'Please try again later',
    ]) {
      const v = classifyTransient(msg);
      expect(v.transient).toBe(true);
      expect(v.hint).toBeTruthy();
    }
  });

  it('classifies Cloud Control bare HandlerErrorCode transient forms', () => {
    for (const code of ['ResourceConflict', 'NetworkFailure', 'InternalFailure', 'Throttling']) {
      expect(classifyTransient(`${code}: something happened`).transient).toBe(true);
    }
  });

  it('classifies throttling with the throttle-specific hint', () => {
    for (const msg of [
      'ThrottlingException: Rate exceeded',
      'TooManyRequestsException',
      'Rate exceeded',
    ]) {
      const v = classifyTransient(msg);
      expect(v.transient).toBe(true);
      expect(v.hint).toContain('throttled');
    }
  });

  it('does NOT classify terminal validation / permission / not-found errors', () => {
    for (const msg of [
      'ValidationException: Invalid property FooBar',
      'AccessDeniedException: not authorized to perform cloudcontrolapi:UpdateResource',
      'ResourceNotFoundException: the resource was not found',
      'InvalidRequest: property is createOnly and cannot be updated',
      'A ServiceLimitExceeded error occurred', // limit != transient in-progress
      undefined,
      '',
    ]) {
      expect(classifyTransient(msg).transient).toBe(false);
    }
  });
});

describe('errorText — best-effort name + message extraction', () => {
  it('prepends the error name when it adds signal', () => {
    const e = Object.assign(new Error("it's currently updating"), { name: 'RSLVR-00705' });
    expect(errorText(e)).toBe("RSLVR-00705: it's currently updating");
  });
  it('does not duplicate a name already present in the message', () => {
    const e = Object.assign(new Error('ThrottlingException: Rate exceeded'), {
      name: 'ThrottlingException',
    });
    expect(errorText(e)).toBe('ThrottlingException: Rate exceeded');
  });
  it('uses the SDK `code` field when there is no `name`', () => {
    expect(errorText({ code: 'Throttling', message: 'slow down' })).toBe('Throttling: slow down');
  });
  it('passes a plain string through unchanged', () => {
    expect(errorText('plain error')).toBe('plain error');
  });
});

describe('retryTransient — bounded backoff, then hint', () => {
  const nap = () => Promise.resolve(); // no real waiting in tests

  it('returns immediately on first success (no retry)', async () => {
    let calls = 0;
    const r = await retryTransient(
      async () => {
        calls++;
        return { ok: true } as RetryableResult;
      },
      { sleep: nap }
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    let calls = 0;
    const r = await retryTransient(
      async () => {
        calls++;
        return calls < 3 ? { ok: false, error: '[RSLVR-00705] currently updating' } : { ok: true };
      },
      { sleep: nap }
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('does NOT retry a terminal failure (returns on first attempt)', async () => {
    let calls = 0;
    const r = await retryTransient(
      async (): Promise<RetryableResult> => {
        calls++;
        return { ok: false, error: 'ValidationException: bad property' };
      },
      { sleep: nap }
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.transient).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });

  it('exhausts retries on a persistent transient failure and annotates the hint', async () => {
    let calls = 0;
    const r = await retryTransient(
      async (): Promise<RetryableResult> => {
        calls++;
        return { ok: false, error: '[RSLVR-00705] currently updating' };
      },
      { maxAttempts: 3, sleep: nap }
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(3); // first + 2 retries
    expect(r.transient).toBe(true);
    expect(r.hint).toContain('async propagation');
  });

  it('waits with linear backoff (baseDelayMs * attempt) between tries', async () => {
    const waits: number[] = [];
    await retryTransient(async () => ({ ok: false, error: 'ThrottlingException: Rate exceeded' }), {
      maxAttempts: 3,
      baseDelayMs: 1000,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([1000, 2000]);
  });
});

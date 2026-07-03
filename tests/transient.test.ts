import { describe, expect, it } from 'vite-plus/test';
import {
  classifyTransient,
  errorText,
  parseDurationMs,
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

  it('classifies stateful-DB mid-modify "not in available state" faults (RDS/ElastiCache/Redshift)', () => {
    for (const msg of [
      'InvalidDBInstanceState: The instance mydb is not in the available state.',
      'InvalidDBClusterStateFault: Cluster is not in available state',
      'InvalidClusterState: cluster is not in the available state', // Redshift
      'InvalidReplicationGroupState: Replication group is not in available state', // ElastiCache
      'InvalidCacheClusterState: not currently in the available state',
      'The DB instance is not in the available state',
    ]) {
      const v = classifyTransient(msg);
      expect(v.transient).toBe(true);
      expect(v.hint).toBe(
        'the resource is still applying a previous update — retry in a few minutes'
      );
    }
  });

  it('#552: classifies DAX mid-modify parameter-group / cluster state faults', () => {
    for (const msg of [
      // The exact live error from the #552 detect→revert live-test.
      'InvalidParameterGroupStateFault: The parameter record-ttl-millis is being modified.',
      'InvalidClusterStateFault: Cluster cdkrd-dax is being modified',
    ]) {
      const v = classifyTransient(msg);
      expect(v.transient).toBe(true);
      expect(v.hint).toBe(
        'the resource is still applying a previous update — retry in a few minutes'
      );
    }
  });

  it('does NOT misclassify a terminal DB error as the mid-modify state fault', () => {
    for (const msg of [
      'DBInstanceNotFound: DBInstance mydb not found',
      'InvalidParameterValue: Invalid backup retention period',
      'InvalidParameterCombination: bad combo',
    ]) {
      expect(classifyTransient(msg).transient).toBe(false);
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

  it('caps a single backoff wait at maxDelayMs', async () => {
    const waits: number[] = [];
    await retryTransient(async () => ({ ok: false, error: 'RSLVR-00705 currently updating' }), {
      maxAttempts: 5,
      baseDelayMs: 10_000,
      maxDelayMs: 15_000,
      sleep: async (ms) => void waits.push(ms),
    });
    // 10s, 20s→cap 15s, 30s→cap 15s, 40s→cap 15s
    expect(waits).toEqual([10_000, 15_000, 15_000, 15_000]);
  });
});

describe('retryTransient — deadline (--wait) mode', () => {
  // A fake clock: each read advances by `step` ms so the loop terminates deterministically
  // without real time. `sleep` is a no-op (the clock, not the sleep, drives the deadline).
  const fakeClock = (step: number) => {
    let t = 0;
    return () => {
      const now = t;
      t += step;
      return now;
    };
  };

  it('retries past maxAttempts until the resource settles (one-command convergence)', async () => {
    let calls = 0;
    const r = await retryTransient(
      async (): Promise<RetryableResult> => {
        calls++;
        return calls < 6 ? { ok: false, error: '[RSLVR-00705] currently updating' } : { ok: true };
      },
      {
        maxAttempts: 3, // ignored in deadline mode
        deadlineMs: 100_000,
        now: fakeClock(1000), // advances slowly, deadline never hit before success
        sleep: () => Promise.resolve(),
      }
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(6); // well past the 3-attempt default
  });

  it('gives up at the deadline and annotates the hint', async () => {
    let calls = 0;
    const r = await retryTransient(
      async (): Promise<RetryableResult> => {
        calls++;
        return { ok: false, error: '[RSLVR-00705] currently updating' };
      },
      {
        deadlineMs: 5000,
        now: fakeClock(2000), // 0, 2000, 4000, 6000 → exceeds 5000 after a few tries
        sleep: () => Promise.resolve(),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.transient).toBe(true);
    expect(r.hint).toContain('async propagation');
    expect(calls).toBeGreaterThan(1);
  });

  it('invokes onRetry before each wait with the attempt number and delay', async () => {
    const seen: { attempt: number; delayMs: number; hint?: string }[] = [];
    await retryTransient(async () => ({ ok: false, error: 'RSLVR-00705 currently updating' }), {
      maxAttempts: 3,
      baseDelayMs: 1000,
      sleep: () => Promise.resolve(),
      onRetry: (info) => seen.push(info),
    });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen[0]?.delayMs).toBe(1000);
    expect(seen[0]?.hint).toContain('async propagation');
  });

  it('does NOT call onRetry for a terminal (non-transient) failure', async () => {
    let called = 0;
    await retryTransient(async () => ({ ok: false, error: 'ValidationException: bad' }), {
      sleep: () => Promise.resolve(),
      onRetry: () => called++,
    });
    expect(called).toBe(0);
  });
});

describe('parseDurationMs', () => {
  it('parses bare number as seconds', () => {
    expect(parseDurationMs('90')).toBe(90_000);
    expect(parseDurationMs('300')).toBe(300_000);
  });
  it('parses s/m/h suffixes', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
  });
  it('tolerates surrounding whitespace', () => {
    expect(parseDurationMs('  5m ')).toBe(300_000);
  });
  it('throws on a malformed value', () => {
    for (const bad of ['5min', 'abc', '', '5.5m', '-3s', 'm']) {
      expect(() => parseDurationMs(bad)).toThrow(/invalid --wait duration/);
    }
  });
});

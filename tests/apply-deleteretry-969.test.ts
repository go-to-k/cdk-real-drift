import { CloudControlClient, DeleteResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  type ApplyResult,
  applyRevertDelete,
  applyRevertDeletes,
  isDependencyViolation,
} from '../src/revert/apply.js';
import type { RevertItem } from '../src/revert/plan.js';

// #969: a delete-batch item whose failure is DEPENDENCY-VIOLATION shaped must fail FAST to
// the applyRevertDeletes pass loop (the pass IS the retry) instead of burning its private
// per-item transient retry / `--wait` deadline against a blocker only the next pass frees.

const cc = mockClient(CloudControlClient);
beforeEach(() => cc.reset());

const deleteItem = (physicalId = 'api123|res456|ANY'): RevertItem => ({
  logicalId: 'Child',
  displayId: 'Api ▸ ANY /a',
  resourceType: 'AWS::ApiGateway::Method',
  physicalId,
  kind: 'delete',
  ops: [],
});

// A ConflictException "referenced by" (ApiGatewayV2 child pair) — the exact #969 example.
const CONFLICT_REFERENCED =
  'ConflictException: Unable to delete Integration integ-x because it is referenced by Route route-y';
// A DependencyViolation (EC2 SG still referenced by an ENI).
const DEP_VIOLATION =
  'DependencyViolation: resource sg-abc has a dependent object and cannot be deleted';
// A GENUINE transient (throttle) — must still get the in-item retry.
const THROTTLE = 'ThrottlingException: Rate exceeded';

describe('isDependencyViolation', () => {
  it('matches DependencyViolation + "referenced by" + "still in use" phrasings', () => {
    expect(isDependencyViolation(DEP_VIOLATION)).toBe(true);
    expect(isDependencyViolation(CONFLICT_REFERENCED)).toBe(true);
    expect(
      isDependencyViolation('Cannot delete Integration because it is referenced by a Route')
    ).toBe(true);
    expect(isDependencyViolation('The security group is still in use')).toBe(true);
  });
  it('does NOT match a throttle / terminal / already-gone error', () => {
    expect(isDependencyViolation(THROTTLE)).toBe(false);
    expect(isDependencyViolation('AccessDeniedException: not authorized')).toBe(false);
    expect(isDependencyViolation('Resource was not found')).toBe(false);
    expect(isDependencyViolation(undefined)).toBe(false);
  });
});

describe('applyRevertDelete — dependency violation fails fast, does NOT burn retry budget (#969)', () => {
  const failedEvent = (msg: string): void => {
    cc.on(DeleteResourceCommand).resolves({
      ProgressEvent: { RequestToken: 't1', OperationStatus: 'FAILED', StatusMessage: msg },
    });
  };

  it('a ConflictException "referenced by" delete sends DeleteResource EXACTLY ONCE (no retry loop)', async () => {
    failedEvent(CONFLICT_REFERENCED);
    let sleeps = 0;
    const r = await applyRevertDelete(
      cc as unknown as CloudControlClient,
      deleteItem(),
      undefined,
      {
        // A full attempt budget — if the dep-violation wrongly entered retryTransient it would
        // send DeleteResource maxAttempts times and sleep between them.
        maxAttempts: 5,
        sleep: () => {
          sleeps++;
          return Promise.resolve();
        },
      }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('referenced by');
    // The transient wrapper was bypassed: ONE send, ZERO backoff sleeps.
    expect(cc.commandCalls(DeleteResourceCommand).length).toBe(1);
    expect(sleeps).toBe(0);
    // Not annotated as a settled-transient (it did not go through the retry-exhaustion path).
    expect(r.transient).toBeUndefined();
  });

  it('a DependencyViolation delete under `--wait` (deadlineMs) does NOT sleep against the deadline', async () => {
    failedEvent(DEP_VIOLATION);
    let sleeps = 0;
    let now = 0;
    const r = await applyRevertDelete(
      cc as unknown as CloudControlClient,
      deleteItem(),
      undefined,
      {
        // `--wait` mode: a 10-minute deadline. Pre-fix, the dep-violation classified transient
        // and this item would spin its whole 10-min budget against a blocker it can never free.
        deadlineMs: 600_000,
        now: () => now,
        sleep: (ms) => {
          sleeps++;
          now += ms;
          return Promise.resolve();
        },
      }
    );
    expect(r.ok).toBe(false);
    expect(cc.commandCalls(DeleteResourceCommand).length).toBe(1);
    expect(sleeps).toBe(0); // fails fast — the `--wait` deadline is never consumed
  });

  it('still retries a GENUINE transient (throttle) in-item and settles on a later attempt', async () => {
    cc.on(DeleteResourceCommand)
      .resolvesOnce({
        ProgressEvent: { RequestToken: 't1', OperationStatus: 'FAILED', StatusMessage: THROTTLE },
      })
      .resolves({ ProgressEvent: { RequestToken: 't2', OperationStatus: 'SUCCESS' } });
    let sleeps = 0;
    const r = await applyRevertDelete(
      cc as unknown as CloudControlClient,
      deleteItem(),
      undefined,
      {
        maxAttempts: 3,
        sleep: () => {
          sleeps++;
          return Promise.resolve();
        },
      }
    );
    expect(r.ok).toBe(true);
    // Throttle → the in-item retry IS engaged: first attempt + one retry = 2 sends, 1 backoff.
    expect(cc.commandCalls(DeleteResourceCommand).length).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('a persistent throttle exhausts the in-item budget and returns a transient hint', async () => {
    cc.on(DeleteResourceCommand).resolves({
      ProgressEvent: { RequestToken: 't1', OperationStatus: 'FAILED', StatusMessage: THROTTLE },
    });
    const r = await applyRevertDelete(
      cc as unknown as CloudControlClient,
      deleteItem(),
      undefined,
      {
        maxAttempts: 3,
        sleep: () => Promise.resolve(),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.transient).toBe(true); // throttle still uses the full retry-then-hint path
    expect(cc.commandCalls(DeleteResourceCommand).length).toBe(3);
  });

  it('a terminal (non-transient) delete failure returns on the first attempt, no retry', async () => {
    failedEvent('Invalid identifier for AWS::ApiGateway::Method');
    const r = await applyRevertDelete(
      cc as unknown as CloudControlClient,
      deleteItem(),
      undefined,
      {
        maxAttempts: 5,
        sleep: () => Promise.resolve(),
      }
    );
    expect(r.ok).toBe(false);
    expect(cc.commandCalls(DeleteResourceCommand).length).toBe(1);
  });
});

describe('applyRevertDeletes — the PASS LOOP resolves the dependency the fast-fail defers (#969)', () => {
  // The real composition: two `added` deletes in wrong order [Integration, Route].
  // Integration fails on a ConflictException "referenced by" (its Route still queued in the
  // same pass) → fast-fails to the pass loop. The Route deletes. Pass 2 re-runs the
  // Integration → the blocker is gone → it succeeds. TOTAL Integration attempts = 2 (one per
  // pass), NOT maxAttempts-per-pass — proving the per-item transient budget never burned.
  it('a wrong-ordered Integration→Route pair converges via the pass loop, not the in-item retry', async () => {
    const integration = deleteItem('api|integ-x'); // must be deleted AFTER the Route
    const route = deleteItem('api|route-y'); // frees the Integration once gone

    let routeDeleted = false;
    let integrationSends = 0;

    // Model each DeleteResource send: Integration fails while the Route lives, then succeeds.
    cc.on(DeleteResourceCommand).callsFake((input) => {
      const id = (input as { Identifier?: string }).Identifier ?? '';
      if (id === 'api|route-y') {
        routeDeleted = true;
        return { ProgressEvent: { RequestToken: 'r', OperationStatus: 'SUCCESS' } };
      }
      // Integration.
      integrationSends++;
      return routeDeleted
        ? { ProgressEvent: { RequestToken: 'i', OperationStatus: 'SUCCESS' } }
        : {
            ProgressEvent: {
              RequestToken: 'i',
              OperationStatus: 'FAILED',
              StatusMessage: CONFLICT_REFERENCED,
            },
          };
    });

    let sleeps = 0;
    const client = cc as unknown as CloudControlClient;
    const outcomes = await applyRevertDeletes(
      [integration, route],
      (item): Promise<ApplyResult> =>
        applyRevertDelete(client, item, item.physicalId, {
          // A generous in-item budget — if the Integration wrongly spun it, integrationSends
          // would be > 2 (maxAttempts on pass 1 alone).
          maxAttempts: 5,
          sleep: () => {
            sleeps++;
            return Promise.resolve();
          },
        })
    );

    // Both deletes converged.
    expect(outcomes.every((o) => o.result.ok)).toBe(true);
    // Integration was attempted ONCE per pass (pass 1 fast-fail + pass 2 success) = 2 sends,
    // NOT the 5-attempt in-item budget. The pass loop owned the retry.
    expect(integrationSends).toBe(2);
    // No backoff waiting was spent on the dependency violation.
    expect(sleeps).toBe(0);
  });

  it('under `--wait` the batch is NOT starved: a fast-fail leaves the deadline intact for the next pass', async () => {
    // Pre-fix, the Integration's in-item wait consumed the whole 10-min deadline before the
    // Route even ran. Now the Integration fails fast (no sleep) → the Route runs immediately →
    // pass 2 converges. Assert ZERO wall-clock was spent sleeping across the whole batch.
    const integration = deleteItem('api|integ-x');
    const route = deleteItem('api|route-y');
    let routeDeleted = false;

    cc.on(DeleteResourceCommand).callsFake((input) => {
      const id = (input as { Identifier?: string }).Identifier ?? '';
      if (id === 'api|route-y') {
        routeDeleted = true;
        return { ProgressEvent: { RequestToken: 'r', OperationStatus: 'SUCCESS' } };
      }
      return routeDeleted
        ? { ProgressEvent: { RequestToken: 'i', OperationStatus: 'SUCCESS' } }
        : {
            ProgressEvent: {
              RequestToken: 'i',
              OperationStatus: 'FAILED',
              StatusMessage: CONFLICT_REFERENCED,
            },
          };
    });

    let now = 0;
    let sleeps = 0;
    const client = cc as unknown as CloudControlClient;
    const outcomes = await applyRevertDeletes(
      [integration, route],
      (item): Promise<ApplyResult> =>
        applyRevertDelete(client, item, item.physicalId, {
          deadlineMs: now + 600_000, // a fresh 10-min `--wait` budget (as buildRetryOpts hands it)
          now: () => now,
          sleep: (ms) => {
            sleeps++;
            now += ms;
            return Promise.resolve();
          },
        })
    );
    expect(outcomes.every((o) => o.result.ok)).toBe(true);
    expect(sleeps).toBe(0);
    expect(now).toBe(0); // no time burned — the pre-fix ~10-min stall is gone
  });
});

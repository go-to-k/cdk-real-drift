// #969 (remainder) — the `revert --wait` deadline for the DELETE batch must be computed ONCE
// per revert run, not re-armed per dependency-aware pass. `applyRevertDeletes` re-invokes the
// per-item apply closure on every pass, so the closure must NOT recompute `clock() + waitMs`
// each time (that lets a genuine persistent throttle on a delete spanning passes wait N × waitMs,
// re-arming a fresh full budget each pass). We assert the SAME delete item receives an IDENTICAL
// `deadlineMs` across its two pass-invocations even though the injected clock advances between
// them — which is only true when the deadline is hoisted out of the per-item builder.
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { GatherResult } from '../src/commands/gather.js';
import type { Finding, SchemaInfo } from '../src/types.js';

// Record every applyRevertDelete invocation's (physicalId, deadlineMs) while keeping the REAL
// applyRevertDeletes pass loop. 'a-phys' succeeds (drives a 2nd pass); 'b-phys' fails transient
// so it is retried on the next pass — the case whose deadline must not re-arm.
const { deadlineCalls } = vi.hoisted(() => ({
  deadlineCalls: [] as { id: string; deadlineMs: number | undefined }[],
}));
vi.mock('../src/revert/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/revert/apply.js')>();
  return {
    ...actual,
    applyRevertDelete: vi.fn(
      async (
        _cc: unknown,
        item: { physicalId: string },
        _identifier: string,
        retry: { deadlineMs?: number } = {}
      ) => {
        deadlineCalls.push({ id: item.physicalId, deadlineMs: retry.deadlineMs });
        return item.physicalId === 'a-phys'
          ? { ok: true }
          : { ok: false, error: 'ThrottlingException', transient: true };
      }
    ),
  };
});

// Imported AFTER the mock is registered (vi.mock is hoisted, so this picks up the mocked apply).
const { revertStack } = await import('../src/commands/stack-actions.js');

const EMPTY_SCHEMA = {
  readOnly: new Set<string>(),
  writeOnly: new Set<string>(),
  createOnly: new Set<string>(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
} as SchemaInfo;

const addedDelete = (logicalId: string, physicalId: string): Finding => ({
  tier: 'added',
  logicalId,
  resourceType: 'AWS::ApiGateway::Method',
  path: '',
  physicalId,
  unrecorded: true, // + removeUnrecorded below → becomes a `delete`-kind plan item
  actual: { HttpMethod: 'ANY' },
});

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources: [
        {
          logicalId: 'DelA',
          resourceType: 'AWS::ApiGateway::Method',
          physicalId: 'a-phys',
          declared: {},
        },
        {
          logicalId: 'DelB',
          resourceType: 'AWS::ApiGateway::Method',
          physicalId: 'b-phys',
          declared: {},
        },
      ],
      rawTemplate: '{}',
      ctx: {
        params: {},
        pseudo: {},
        conditions: {},
        physIds: {},
        liveAttrs: {},
        mappings: {},
        exports: {},
        condCache: new Map(),
      },
    },
    findings: [addedDelete('DelA', 'a-phys'), addedDelete('DelB', 'b-phys')],
    schemas: new Map([['AWS::ApiGateway::Method', EMPTY_SCHEMA]]),
    liveByLogical: new Map(),
  }) as GatherResult;

describe('#969 revert --wait delete-batch deadline is computed ONCE, not re-armed per pass', () => {
  let cc: ReturnType<typeof mockClient>;
  let cfn: ReturnType<typeof mockClient>;
  beforeEach(() => {
    deadlineCalls.length = 0;
    cc = mockClient(CloudControlClient);
    // The scoped convergence re-read after apply — resource "gone" is fine; we only assert on
    // the recorded apply-time deadlines.
    cc.on(GetResourceCommand).rejects(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
    );
    cfn = mockClient(CloudFormationClient);
    cfn
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
  });
  afterEach(() => {
    cc.restore();
    cfn.restore();
  });

  it('the same delete item gets an IDENTICAL deadline across its two dependency-aware passes', async () => {
    // A clock that ADVANCES on every read — so a per-pass `clock() + waitMs` (the bug) would
    // yield a LATER deadline on the 2nd pass; a hoisted single deadline stays constant.
    let t = 1000;
    const waitNow = () => (t += 1000);
    const orig = console.log;
    console.log = () => {};
    try {
      await revertStack({
        stackName: 's',
        region: 'r',
        gathered: gathered(),
        baseline: undefined,
        config: { ignore: [] },
        dryRun: false,
        yes: true,
        removeUnrecorded: true, // unrecorded added → delete items
        verbose: false,
        interactive: false,
        convergeRetryDelayMs: 0,
        waitMs: 500_000,
        waitNow,
        waitSleep: () => Promise.resolve(),
      } as Parameters<typeof revertStack>[0]);
    } finally {
      console.log = orig;
    }

    // 'a-phys' succeeds pass 0 (progress) → 'b-phys' is retried on pass 1: two invocations.
    const bCalls = deadlineCalls.filter((c) => c.id === 'b-phys');
    expect(bCalls.length).toBe(2);
    expect(bCalls[0]!.deadlineMs).toBeDefined();
    // The fix: identical deadline both passes (single per-run budget). The bug (per-pass
    // clock() + waitMs) would make the 2nd strictly greater because the clock advanced.
    expect(bCalls[1]!.deadlineMs).toBe(bCalls[0]!.deadlineMs);
  });
});

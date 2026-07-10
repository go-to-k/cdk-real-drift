import {
  CloudControlClient,
  GetResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { GatherResult } from '../src/commands/gather.js';
import { revertStack } from '../src/commands/stack-actions.js';
import type { Finding, SchemaInfo } from '../src/types.js';

// #952: the apply loop must STREAM each resource's `reverted:`/`FAILED:` line the moment
// its item resolves, instead of buffering the whole batch and printing only after every
// item completes. A Ctrl-C mid-apply otherwise leaves ZERO trace of what already happened.
// We assert the streaming ORDERING: when a LATER resource's UpdateResource runs, the EARLIER
// resource's `reverted:` line is ALREADY in the log — impossible under the old buffered path
// (which emitted nothing until both items had finished).

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

// Two roles, each with an out-of-band MaxSessionDuration (undeclared) → each reverts an
// `add /MaxSessionDuration = 3600` op. A per-resource item → two apply iterations.
const undeclaredMsd = (logicalId: string, physicalId: string): Finding => ({
  tier: 'undeclared',
  logicalId,
  resourceType: 'AWS::IAM::Role',
  path: 'MaxSessionDuration',
  physicalId,
  actual: 7200,
});

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources: [
        { logicalId: 'A', resourceType: 'AWS::IAM::Role', physicalId: 'a-phys', declared: {} },
        { logicalId: 'B', resourceType: 'AWS::IAM::Role', physicalId: 'b-phys', declared: {} },
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
    findings: [undeclaredMsd('A', 'a-phys'), undeclaredMsd('B', 'b-phys')],
    schemas: new Map([['AWS::IAM::Role', EMPTY_SCHEMA]]),
    liveByLogical: new Map(),
  }) as GatherResult;

const params = (extra: Record<string, unknown> = {}) => ({
  stackName: 's',
  region: 'r',
  gathered: gathered(),
  baseline: undefined,
  config: { ignore: [] },
  dryRun: false,
  yes: true,
  removeUnrecorded: true,
  verbose: false,
  interactive: false,
  convergeRetryDelayMs: 0,
  ...extra,
});

const liveRead = (value: number) => ({
  ResourceDescription: {
    Identifier: 'x',
    Properties: JSON.stringify({ MaxSessionDuration: value }),
  },
});

describe('revertStack #952 — per-item outcome is streamed, not buffered', () => {
  let cfnMock: ReturnType<typeof mockClient>;
  let ccMock: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
    ccMock = mockClient(CloudControlClient);
    // The default write lands (live re-reads 3600) so both revert cleanly.
    ccMock.on(GetResourceCommand).resolves(liveRead(3600));
  });
  afterEach(() => {
    cfnMock.restore();
    ccMock.restore();
  });

  const runCapturing = async (onUpdate?: (physicalId: string, logs: string[]) => void) => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    ccMock.on(UpdateResourceCommand).callsFake((input: { Identifier?: string }) => {
      onUpdate?.(String(input.Identifier), logs);
      return { ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' } };
    });
    try {
      const outcome = await revertStack(params());
      return { outcome, logs };
    } finally {
      console.log = orig;
    }
  };

  it("the earlier resource's `reverted:` line is already printed when the next item applies", async () => {
    // Count how many `reverted:` lines exist AT THE MOMENT each resource's UpdateResource runs.
    const revertedLinesSeenBeforeUpdate = new Map<string, number>();
    await runCapturing((physicalId, logs) => {
      const count = logs.filter((l) => l.includes('reverted:')).length;
      revertedLinesSeenBeforeUpdate.set(physicalId, count);
    });
    // The first item's UpdateResource runs with 0 prior `reverted:` lines (nothing done yet).
    expect(revertedLinesSeenBeforeUpdate.get('a-phys')).toBe(0);
    // The SECOND item's UpdateResource runs AFTER the first was streamed → 1 prior line.
    // Under the OLD buffered path this would still be 0 (nothing printed until the batch end).
    expect(revertedLinesSeenBeforeUpdate.get('b-phys')).toBe(1);
  });

  it('does not double-print: each resource yields exactly ONE `reverted:` line', async () => {
    const { logs } = await runCapturing();
    const joined = logs.join('\n');
    // One line per resource — the end-of-batch pass must NOT reprint the streamed lines.
    const revertedLines = logs.filter((l) => l.includes('reverted:'));
    expect(revertedLines).toHaveLength(2);
    expect(joined).toContain('reverted: A');
    expect(joined).toContain('reverted: B');
  });

  it('streams under text mode but stays silent under --json (no per-item lines on stdout)', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    ccMock.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
    try {
      const outcome = await revertStack(params({ json: true }));
      expect(logs.some((l) => l.includes('reverted:'))).toBe(false);
      // The machine-readable tallies are still produced on the outcome.
      expect(outcome.reverted).toBe(2);
    } finally {
      console.log = orig;
    }
  });
});

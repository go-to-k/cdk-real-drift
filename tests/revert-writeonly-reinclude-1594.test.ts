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

// #1594: the #763 silent-no-op-`add` detector flagged the WRITE-ONLY RE-INCLUDE op
// (the `add /MasterUserPassword` every revert of a password-declaring resource carries
// for the Cloud Control read-modify-write contract) as a false "NOT reverted ... no-op":
// a write-only path re-reads as a readGap finding whose `actual` is undefined on BOTH
// sides, so deepEqual(pre, post) was vacuously true and `post.actual !== op.value`
// trivially held. A readGap re-read carries no live value and must never drive a
// "the value persists" verdict — live-hit on every RDS revert (aurora-pg-sv2-min,
// 2026-07-14).

const schema: SchemaInfo = {
  readOnly: new Set<string>(),
  writeOnly: new Set<string>(['MasterUserPassword']),
  createOnly: new Set<string>(),
  readOnlyPaths: [],
  writeOnlyPaths: ['MasterUserPassword'],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const declared = { Description: 'intended', MasterUserPassword: 'pw' };

// A REAL declared drift (Description changed out of band) + the readGap finding the
// declared write-only password always produces.
const findings = (): Finding[] => [
  {
    tier: 'declared',
    logicalId: 'R',
    resourceType: 'AWS::IAM::Role',
    path: 'Description',
    physicalId: 'r-phys',
    desired: 'intended',
    actual: 'oob-changed',
  },
  {
    tier: 'readGap',
    logicalId: 'R',
    resourceType: 'AWS::IAM::Role',
    path: 'MasterUserPassword',
    physicalId: 'r-phys',
    actual: undefined,
  },
];

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources: [
        { logicalId: 'R', resourceType: 'AWS::IAM::Role', physicalId: 'r-phys', declared },
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
    findings: findings(),
    schemas: new Map([['AWS::IAM::Role', schema]]),
    liveByLogical: new Map(),
  }) as GatherResult;

const params = () => ({
  stackName: 's',
  region: 'r',
  gathered: gathered(),
  baseline: undefined,
  config: { ignore: [] },
  dryRun: false,
  yes: true,
  removeUnrecorded: false,
  verbose: false,
  interactive: false,
  convergeRetryDelayMs: 0,
});

const run = async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => logs.push(String(s));
  try {
    const outcome = await revertStack(params());
    return { outcome, logs: logs.join('\n') };
  } finally {
    console.log = orig;
  }
};

describe('revertStack #1594 — a write-only re-include op is not a false no-op', () => {
  let cfnMock: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
  });
  afterEach(() => cfnMock.restore());

  it('a converged revert carrying the password re-include is CLEAN, exit 0', async () => {
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
    // The re-read never returns the write-only password (readGap on both sides); the
    // real drift (Description) converged to the declared value.
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'r-phys',
        Properties: JSON.stringify({ Description: 'intended' }),
      },
    });

    const { outcome, logs } = await run();
    expect(logs).toContain('re-include write-only');
    expect(logs).not.toContain('NOT reverted:');
    expect(logs).not.toContain('could not be confirmed converged');
    expect(logs).toContain('s: CLEAN after revert.');
    expect(outcome.exit).toBe(0);
  });
});

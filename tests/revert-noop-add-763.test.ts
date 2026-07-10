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

// #763: the #631 silent-no-op detector only inspected `remove` ops. An `add`-shaped
// set-default write (REVERT_SET_DEFAULT_PATHS / KNOWN_DEFAULT_PATHS) that an omit/ignore
// provider ACCEPTS-BUT-IGNORES slips through every net and prints a false "CLEAN after
// revert." while the out-of-band value persists:
//   - the value re-reads as an UNRECORDED undeclared → excluded by isDrift → not in `remaining`;
//   - the item applied "ok" → not in `failedUpdateIds`;
//   - the op is `add` → skipped by the old no-op loop → converged = true.
// AWS::IAM::Role\0MaxSessionDuration is a REVERT_SET_DEFAULT_PATHS entry (KNOWN_DEFAULTS
// default 3600): reverting an unrecorded out-of-band value emits an `add` op writing 3600.

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

// An out-of-band MaxSessionDuration (7200) on a role that never declared it → an
// unrecorded undeclared finding (no baseline). Revert emits `add /MaxSessionDuration = 3600`.
const undeclaredMsd = (): Finding => ({
  tier: 'undeclared',
  logicalId: 'R',
  resourceType: 'AWS::IAM::Role',
  path: 'MaxSessionDuration',
  physicalId: 'r-phys',
  actual: 7200,
});

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources: [
        { logicalId: 'R', resourceType: 'AWS::IAM::Role', physicalId: 'r-phys', declared: {} },
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
    findings: [undeclaredMsd()],
    schemas: new Map([['AWS::IAM::Role', EMPTY_SCHEMA]]),
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
  removeUnrecorded: true, // include the unrecorded add-op default write in the plan
  verbose: false,
  interactive: false,
  convergeRetryDelayMs: 0,
});

// The live re-read returns a role whose MaxSessionDuration is `value`.
const liveRead = (value: number) => ({
  ResourceDescription: {
    Identifier: 'r-phys',
    Properties: JSON.stringify({ MaxSessionDuration: value }),
  },
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

describe('revertStack #763 — an ignored add-op set-default write is NOT CLEAN', () => {
  let cfnMock: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
  });
  afterEach(() => cfnMock.restore());

  const mockApplySuccess = (cc: ReturnType<typeof mockClient>) => {
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
  };

  // The provider accepted the UpdateResource (SUCCESS) but IGNORED the explicit default
  // write: the live value re-reads UNCHANGED at the out-of-band 7200 (== pre.actual, and
  // != the 3600 the add tried to write). Before the fix this printed a false CLEAN.
  it('add-op default write the provider ignored → NOT CLEAN, exit 1 (persisted value detected)', async () => {
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc); // UpdateResource "succeeds"...
    cc.on(GetResourceCommand).resolves(liveRead(7200)); // ...but the value persists unchanged

    const { outcome, logs } = await run();
    expect(logs).not.toContain('CLEAN after revert');
    expect(logs).toContain('NOT reverted:');
    expect(logs).toContain('MaxSessionDuration');
    expect(logs).toContain('the default-value write was a no-op');
    expect(logs).toContain('could not be confirmed converged');
    expect(outcome.exit).toBe(1);
  });

  // Control (no false negative): the add-op write DID take — the live value re-reads as the
  // 3600 default (!= the 7200 pre value). It is NOT a no-op, so the stack is CLEAN, exit 0.
  it('add-op default write that DID take (live == op.value) → CLEAN, exit 0', async () => {
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc);
    cc.on(GetResourceCommand).resolves(liveRead(3600)); // the default write landed

    const { outcome, logs } = await run();
    expect(logs).toContain('s: CLEAN after revert.');
    expect(logs).not.toContain('NOT reverted:');
    expect(outcome.exit).toBe(0);
  });
});

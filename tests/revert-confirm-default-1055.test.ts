import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { GatherResult } from '../src/commands/gather.js';
import type { Finding, SchemaInfo } from '../src/types.js';

// #1055: the ONE AWS-write confirm in revert must NOT default to Yes — pressing Enter
// at "This WRITES to AWS." must be treated as No, matching record's empty-baseline
// confirm (which already passes initialValue: false). We mock @clack/prompts `confirm`
// so we can assert HOW revertStack calls it (initialValue) and drive its return value.
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, confirm: vi.fn(), isCancel: () => false };
});

import { confirm } from '@clack/prompts';
import { revertStack } from '../src/commands/stack-actions.js';

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

const declared = (): Finding => ({
  tier: 'declared',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration',
  physicalId: 'b-phys',
  desired: { Status: 'Enabled' },
  actual: { Status: 'Suspended' },
});

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources: [
        {
          logicalId: 'B',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'b-phys',
          declared: { VersioningConfiguration: { Status: 'Enabled' } },
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
    findings: [declared()],
    schemas: new Map([['AWS::S3::Bucket', EMPTY_SCHEMA]]),
    liveByLogical: new Map(),
  }) as GatherResult;

// yes:false + interactive:true reaches the AWS-write confirm; autoSelectAll:true skips
// the multiselect so the confirm is the ONLY prompt. The confirm mock returns false, so
// the write is declined and nothing hits AWS — we only care that it was CALLED right.
const params = () =>
  ({
    stackName: 's',
    region: 'r',
    gathered: gathered(),
    baseline: undefined,
    config: { ignore: [] },
    dryRun: false,
    yes: false,
    removeUnrecorded: false,
    verbose: false,
    interactive: true,
    autoSelectAll: true,
    convergeRetryDelayMs: 0,
  }) as unknown as Parameters<typeof revertStack>[0];

describe('revert AWS-write confirm default (#1055)', () => {
  beforeEach(() => {
    mockClient(CloudControlClient);
    vi.mocked(confirm).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('is invoked with initialValue:false so Enter/default is No', async () => {
    // Default the confirm to "declined" — the return value is irrelevant to the assertion,
    // but declining keeps the AWS write from firing.
    vi.mocked(confirm).mockResolvedValue(false as never);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    let outcome: Awaited<ReturnType<typeof revertStack>>;
    try {
      outcome = await revertStack(params());
    } finally {
      console.log = orig;
    }

    expect(confirm).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(confirm).mock.calls[0]?.[0] as {
      message: string;
      initialValue?: boolean;
    };
    // The prompt we guarded is the AWS-WRITE one, not some other confirm.
    expect(arg.message).toContain('This WRITES to AWS.');
    // The regression fix: a destructive write must default to No.
    expect(arg.initialValue).toBe(false);
    // Declining the confirm aborts without touching AWS.
    expect(outcome).toMatchObject({ aborted: true });
  });
});

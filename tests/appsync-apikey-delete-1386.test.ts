// #1386 — reverting an `added` AWS::AppSync::ApiKey must route through the service's own
// DeleteApiKey, NOT Cloud Control DeleteResource: CC has no DELETE handler for the type
// (UnsupportedActionException), so the #1367 enumerator could detect the out-of-band key
// but `revert --remove-unrecorded` failed to remove it. The SDK deleter (SDK_DELETERS,
// the delete analog of SDK_WRITERS — the #1312 class of type-specific SDK routing)
// addresses the key as { apiId, id }: `id` is the bare ApiKeyId the finding carries as
// physicalId, `apiId` derives from the PARENT GraphQLApi's ARN-form CFn physical id
// (`arn:...:apis/<apiId>` → trailing segment), recovered at the stack-actions call site
// from the added finding's synthesized `${parentLogicalId}/${identifier}` logicalId.
import { AppSyncClient, DeleteApiKeyCommand } from '@aws-sdk/client-appsync';
import {
  CloudControlClient,
  DeleteResourceCommand,
  GetResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { GatherResult } from '../src/commands/gather.js';
import { revertStack } from '../src/commands/stack-actions.js';
import { applyRevertDeleteSdk } from '../src/revert/apply.js';
import { SDK_DELETERS } from '../src/revert/writers.js';
import type { Finding, SchemaInfo } from '../src/types.js';

const noNap = { sleep: () => Promise.resolve() };

const API_ARN = 'arn:aws:appsync:us-east-1:111122223333:apis/abc123xyz';
const KEY_ID = 'da2-aaaabbbbccccdddd';

// ── the deleter itself: { apiId, id } wiring ─────────────────────────────────

describe('SDK_DELETERS[AWS::AppSync::ApiKey] — DeleteApiKey with { apiId, id } (#1386)', () => {
  const appsync = mockClient(AppSyncClient);
  beforeEach(() => appsync.reset());
  afterEach(() => appsync.restore());

  const deleter = SDK_DELETERS['AWS::AppSync::ApiKey']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('derives apiId from the parent ARN trailing segment (the enumerator bareApiId form)', async () => {
    appsync.on(DeleteApiKeyCommand).resolves({});
    await deleter({ physicalId: KEY_ID, parentPhysicalId: API_ARN, region: 'us-east-1' });
    const calls = appsync.commandCalls(DeleteApiKeyCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input).toEqual({ apiId: 'abc123xyz', id: KEY_ID });
  });

  it('passes a bare (non-ARN) parent physical id through as the apiId', async () => {
    appsync.on(DeleteApiKeyCommand).resolves({});
    await deleter({ physicalId: KEY_ID, parentPhysicalId: 'abc123xyz', region: 'us-east-1' });
    expect(appsync.commandCalls(DeleteApiKeyCommand)[0]!.args[0].input).toEqual({
      apiId: 'abc123xyz',
      id: KEY_ID,
    });
  });

  it('throws (an honest FAILED, not a silent skip) when the parent api id is unresolvable', async () => {
    await expect(deleter({ physicalId: KEY_ID, region: 'us-east-1' })).rejects.toThrow(
      /parent GraphQLApi/
    );
    expect(appsync.commandCalls(DeleteApiKeyCommand).length).toBe(0);
  });
});

// ── applyRevertDeleteSdk: same contract as the Cloud Control delete path ─────

describe('applyRevertDeleteSdk — CC-path parity semantics (#1386)', () => {
  it('success → ok:true after one call', async () => {
    let calls = 0;
    const r = await applyRevertDeleteSdk(async () => {
      calls++;
    }, noNap);
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it('treats an already-gone target (thrown NotFoundException) as SUCCESS', async () => {
    const e = new Error(`API key ${KEY_ID} not found`);
    e.name = 'NotFoundException';
    const r = await applyRevertDeleteSdk(() => Promise.reject(e), noNap);
    expect(r).toEqual({ ok: true });
  });

  it('still FAILS on a genuine error', async () => {
    const e = new Error('not authorized to perform appsync:DeleteApiKey');
    e.name = 'AccessDeniedException';
    const r = await applyRevertDeleteSdk(() => Promise.reject(e), noNap);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not authorized');
  });

  it('retries a genuine transient (throttle) with the full retryTransient semantics', async () => {
    let calls = 0;
    const r = await applyRevertDeleteSdk(() => {
      calls++;
      if (calls === 1) {
        const e = new Error('Rate exceeded');
        e.name = 'ThrottlingException';
        return Promise.reject(e);
      }
      return Promise.resolve();
    }, noNap);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('fails FAST on a dependency violation (defers to the pass loop, no retry burn — #969)', async () => {
    let calls = 0;
    const e = new Error('cannot be deleted because it is still in use by another resource');
    const r = await applyRevertDeleteSdk(
      () => {
        calls++;
        return Promise.reject(e);
      },
      { maxAttempts: 3, ...noNap }
    );
    expect(r.ok).toBe(false);
    // The REAL error text is restored for the caller, not the internal terminal sentinel.
    expect(r.error).toContain('still in use');
    expect(calls).toBe(1);
  });
});

// ── end-to-end routing at the stack-actions delete batch ─────────────────────

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

// An out-of-band `added` child finding as gather.ts addedFinding synthesizes it:
// logicalId = `${parentLogicalId}/${ccIdentifier}`, physicalId = the CC identifier.
const addedFinding = (
  parentLogicalId: string,
  identifier: string,
  resourceType: string
): Finding => ({
  tier: 'added',
  logicalId: `${parentLogicalId}/${identifier}`,
  resourceType,
  path: '',
  physicalId: identifier,
  unrecorded: true, // + removeUnrecorded below → becomes a `delete`-kind plan item
  actual: { Id: identifier },
});

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'us-east-1',
      accountId: '111122223333',
      resources: [
        {
          logicalId: 'Api',
          resourceType: 'AWS::AppSync::GraphQLApi',
          physicalId: API_ARN, // ARN form — the apiId must be its trailing segment
          declared: {},
        },
        {
          logicalId: 'Rest',
          resourceType: 'AWS::ApiGateway::RestApi',
          physicalId: 'rest123',
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
    findings: [
      addedFinding('Api', KEY_ID, 'AWS::AppSync::ApiKey'),
      // A CONTROL delete of a CC-deletable type in the SAME batch: must still go to CC.
      addedFinding('Rest', 'rest123|res456|ANY', 'AWS::ApiGateway::Method'),
    ],
    schemas: new Map([
      ['AWS::AppSync::ApiKey', EMPTY_SCHEMA],
      ['AWS::ApiGateway::Method', EMPTY_SCHEMA],
    ]),
    liveByLogical: new Map(),
  }) as GatherResult;

describe('revert routes an added AWS::AppSync::ApiKey delete via the SDK, not CC (#1386)', () => {
  let cc: ReturnType<typeof mockClient>;
  let cfn: ReturnType<typeof mockClient>;
  let appsync: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cc = mockClient(CloudControlClient);
    cc.on(DeleteResourceCommand).resolves({
      ProgressEvent: { RequestToken: 't', OperationStatus: 'SUCCESS' },
    });
    // The scoped convergence re-read after apply — "gone" is the converged state here.
    cc.on(GetResourceCommand).rejects(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
    );
    cfn = mockClient(CloudFormationClient);
    cfn
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
    appsync = mockClient(AppSyncClient);
    appsync.on(DeleteApiKeyCommand).resolves({});
  });
  afterEach(() => {
    cc.restore();
    cfn.restore();
    appsync.restore();
  });

  it('ApiKey → appsync DeleteApiKey { apiId, id }; the sibling Method delete stays on CC', async () => {
    const orig = console.log;
    console.log = () => {};
    try {
      await revertStack({
        stackName: 's',
        region: 'us-east-1',
        gathered: gathered(),
        baseline: undefined,
        config: { ignore: [] },
        dryRun: false,
        yes: true,
        removeUnrecorded: true, // unrecorded added → delete items
        verbose: false,
        interactive: false,
        convergeRetryDelayMs: 0,
        waitSleep: () => Promise.resolve(),
      } as Parameters<typeof revertStack>[0]);
    } finally {
      console.log = orig;
    }

    // The ApiKey delete went to the service SDK with the parent-derived apiId…
    const sdkCalls = appsync.commandCalls(DeleteApiKeyCommand);
    expect(sdkCalls.length).toBe(1);
    expect(sdkCalls[0]!.args[0].input).toEqual({ apiId: 'abc123xyz', id: KEY_ID });

    // …and NEVER to Cloud Control DeleteResource (the pre-fix UnsupportedActionException
    // path); the CC-deletable sibling in the same batch still goes through CC unchanged.
    const ccCalls = cc.commandCalls(DeleteResourceCommand);
    expect(ccCalls.map((c) => (c.args[0].input as { TypeName?: string }).TypeName)).toEqual([
      'AWS::ApiGateway::Method',
    ]);
  });
});

// Regression tests for issue #784 — two gaps in Fn::ImportValue support:
//   Gap 1: exportsCache keyed by region only (account axis missing) → account A's
//          exports served to account B's same-region stack (wrong-value resolution).
//   Gap 2: a ListExports permission error hard-failed the WHOLE stack check (exit 2)
//          instead of degrading the ImportValue-consuming properties to `unresolved`.
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListExportsCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { listExports, loadDesired } from '../src/desired/template-adapter.js';

// A minimal fake CloudFormationClient whose send() returns a caller-supplied result and
// counts calls — enough to exercise listExports' cache key directly.
function fakeClient(sendImpl: () => Promise<unknown>) {
  const send = vi.fn(sendImpl);
  return { client: { send } as unknown as CloudFormationClient, send };
}

describe('listExports account+region cache key (#784 Gap 1)', () => {
  it('does NOT serve account A exports to account B in the same region', async () => {
    // send returns DIFFERENT exports per invocation so a cache hit is detectable.
    let call = 0;
    const { client, send } = fakeClient(async () => {
      call += 1;
      return call === 1
        ? { Exports: [{ Name: 'Shared', Value: 'account-A-value' }] }
        : { Exports: [{ Name: 'Shared', Value: 'account-B-value' }] };
    });

    const region = 'ap-southeast-2'; // distinct combo to avoid module-cache bleed
    const a = await listExports(client, '111111111111', region);
    const b = await listExports(client, '222222222222', region);

    expect(a).toEqual({ Shared: 'account-A-value' });
    // If the cache keyed on region alone, account B would receive account A's cached value.
    expect(b).toEqual({ Shared: 'account-B-value' });
    expect(b).not.toEqual(a);
    expect(send).toHaveBeenCalledTimes(2); // separate account → separate fetch
  });

  it('caches on the SECOND call for the same account+region (single fetch)', async () => {
    const { client, send } = fakeClient(async () => ({
      Exports: [{ Name: 'Shared', Value: 'v' }],
    }));

    const acct = '333333333333';
    const region = 'ca-central-1'; // distinct combo to avoid module-cache bleed
    const first = await listExports(client, acct, region);
    const second = await listExports(client, acct, region);

    expect(second).toBe(first); // same cached object
    expect(send).toHaveBeenCalledTimes(1); // second call served from cache
  });
});

describe('loadDesired degrades on ListExports failure (#784 Gap 2)', () => {
  function stackMocks(cfn: ReturnType<typeof mockClient>, templateBody: string) {
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: templateBody });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Q',
          PhysicalResourceId: 'q-phys',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:eu-north-1:999988887777:stack/IV784/x',
          StackName: 'IV784',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT throw when ListExports is denied; leaves the import UNRESOLVED', async () => {
    const cfn = mockClient(CloudFormationClient);
    stackMocks(
      cfn,
      JSON.stringify({
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { Tag: { 'Fn::ImportValue': 'SharedArn' } } },
        },
      })
    );
    const denied = Object.assign(
      new Error('User is not authorized to perform: cloudformation:ListExports'),
      {
        name: 'AccessDeniedException',
      }
    );
    cfn.on(ListExportsCommand).rejects(denied);

    // Silence the degradation warning the fix emits to stderr, and assert it fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // distinct region so the module-level exports cache can't cross-contaminate.
    const desired = await loadDesired(
      cfn as unknown as CloudFormationClient,
      'IV784',
      'eu-north-1'
    );

    // No hard failure; the whole stack still loaded.
    expect(desired.resources).toHaveLength(1);
    // The import could not be resolved → the property is NOT the (missing) export value.
    // ctx.exports stayed its default empty object, so the import degrades to unresolved
    // (the declared property carries no resolved value from the export).
    expect(desired.ctx.exports).toEqual({});
    expect(desired.resources[0]!.declared).not.toEqual({ Tag: 'arn:aws:x:::shared' });

    // The degradation was surfaced (not silently swallowed).
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('cloudformation:ListExports');
  });
});

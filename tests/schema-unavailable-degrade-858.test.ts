import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeTypeCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vite-plus/test';
import { gatherFindings } from '../src/commands/gather.js';

// #858 (the deferred half of #1067): when the schema for a resource type is UNAVAILABLE
// (DescribeType failed — throttle/deny), gather returns an EMPTY degraded schema (#751).
// Diffing a resource against that EMPTY is wrong in BOTH directions:
//   1. readOnly live attrs (Arn/ids/timestamps) are not stripped → flood `[Potential Drift]`
//      (the first-run-noise invariant is violated).
//   2. declared writeOnly props are not routed to readGap → compared against an absent live
//      value → red `[CFn-Declared Drift]` → `--fail` exits 1 on an untouched stack.
// Surfacing a known-wrong diff is worse than admitting the coverage gap, so gather now DEGRADES
// the resource to a single `skipped` finding (coverage-incomplete) instead of classifying it.
//
// NOTE: schema-strip.ts keeps a PROCESS-level schema cache keyed on `${region}\0${type}`, so a
// SUCCESSFUL fetch of a type in a prior test would let a later test find it cached (no DescribeType
// call → no degrade). Each test therefore uses a UNIQUE resource type to stay isolated.

const DEGRADE_NOTE = 'schema unavailable (DescribeType failed) — coverage incomplete';

// A schema marking the live-only `Arn` readOnly — so with the REAL schema Arn is stripped
// (folded), but under the EMPTY (failed fetch) it would false-surface as undeclared drift.
const okSchema = JSON.stringify({
  properties: { QueueName: { type: 'string' }, Arn: { type: 'string' } },
  readOnlyProperties: ['/properties/Arn'],
});

function baseStack(cfn: ReturnType<typeof mockClient>, resourceType: string, ids: string[]) {
  cfn.on(GetTemplateCommand).resolves({
    TemplateBody: JSON.stringify({
      Resources: Object.fromEntries(
        ids.map((id) => [id, { Type: resourceType, Properties: { QueueName: `${id}-q` } }])
      ),
    }),
  });
  cfn.on(ListStackResourcesCommand).resolves({
    StackResourceSummaries: ids.map((id) => ({
      LogicalResourceId: id,
      PhysicalResourceId: `${id}-phys`,
      ResourceType: resourceType,
      LastUpdatedTimestamp: new Date(0),
      ResourceStatus: 'CREATE_COMPLETE' as const,
    })),
  });
  cfn.on(DescribeStacksCommand).resolves({
    Stacks: [
      {
        StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
        StackName: 'S',
        CreationTime: new Date(0),
        StackStatus: 'CREATE_COMPLETE',
        Parameters: [],
      },
    ],
  });
}

// Both queues read back the declared QueueName PLUS a live-only `Arn` — which, under the EMPTY
// schema, is NOT stripped → would false-surface as undeclared drift.
function stubLiveReads(cc: ReturnType<typeof mockClient>) {
  cc.on(GetResourceCommand).callsFake((input: { Identifier: string }) => {
    const id = String(input.Identifier).replace('-phys', '');
    return Promise.resolve({
      ResourceDescription: {
        Identifier: input.Identifier,
        Properties: JSON.stringify({
          QueueName: `${id}-q`,
          Arn: `arn:aws:sqs:us-east-1:111122223333:${id}-q`,
        }),
      },
    });
  });
}

describe('gather degrades to skipped when the schema is unavailable (#858)', () => {
  it('emits a skipped coverage finding instead of diffing against the EMPTY schema', async () => {
    const resourceType = 'AWS::Test858::Fail';
    const cfn = mockClient(CloudFormationClient);
    baseStack(cfn, resourceType, ['Q1']);
    // DescribeType FAILS — schema-strip returns the EMPTY degraded schema with failed:true.
    cfn.on(DescribeTypeCommand).rejects(new Error('ThrottlingException'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cc = mockClient(CloudControlClient);
    stubLiveReads(cc);

    const { findings } = await gatherFindings('S', 'us-east-1');
    const q1 = findings.filter((f) => f.logicalId === 'Q1');

    // The resource is a single `skipped` coverage-gap finding — NOT a diff against the EMPTY.
    expect(q1).toHaveLength(1);
    expect(q1[0]).toMatchObject({
      tier: 'skipped',
      logicalId: 'Q1',
      resourceType,
      path: '',
      note: DEGRADE_NOTE,
    });

    // NOT surfaced as undeclared/declared drift against the unstripped model (the #858 bug).
    expect(q1.some((f) => f.tier === 'undeclared' || f.tier === 'declared')).toBe(false);
    expect(findings.some((f) => f.tier === 'undeclared' && f.path === 'Arn')).toBe(false);
  });

  it('classifies normally when the schema fetch SUCCEEDS (regression guard)', async () => {
    const resourceType = 'AWS::Test858::Ok';
    const cfn = mockClient(CloudFormationClient);
    baseStack(cfn, resourceType, ['Q1']);
    // DescribeType SUCCEEDS with a schema marking `Arn` readOnly (so it is stripped, folded).
    cfn.on(DescribeTypeCommand).resolves({ Schema: okSchema });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cc = mockClient(CloudControlClient);
    stubLiveReads(cc);

    const { findings } = await gatherFindings('S', 'us-east-1');
    // A real schema classifies normally: no degrade finding, and the readOnly Arn is stripped.
    expect(findings.some((f) => f.logicalId === 'Q1' && f.note === DEGRADE_NOTE)).toBe(false);
    expect(
      findings.some((f) => f.logicalId === 'Q1' && f.tier === 'undeclared' && f.path === 'Arn')
    ).toBe(false);
  });

  it('re-fetches for a later resource of the same type after an earlier fetch failed (#1067)', async () => {
    const resourceType = 'AWS::Test858::Refetch';
    const cfn = mockClient(CloudFormationClient);
    baseStack(cfn, resourceType, ['Q1', 'Q2']);
    // FIRST DescribeType throws (Q1 degrades to skipped); SECOND succeeds (Q2 classifies clean).
    const describeType = vi
      .fn()
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue({ Schema: okSchema });
    cfn.on(DescribeTypeCommand).callsFake(describeType);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cc = mockClient(CloudControlClient);
    stubLiveReads(cc);

    const { findings } = await gatherFindings('S', 'us-east-1');

    // The failure was NOT cached (#751/#1067), so Q2 re-fetched: DescribeType ran TWICE.
    expect(describeType).toHaveBeenCalledTimes(2);
    // Q1 (failed fetch) degraded to the skipped coverage finding — NOT a diff against EMPTY.
    expect(findings.some((f) => f.logicalId === 'Q1' && f.note === DEGRADE_NOTE)).toBe(true);
    expect(findings.some((f) => f.logicalId === 'Q1' && f.tier === 'undeclared')).toBe(false);
    // Q2 re-fetched the REAL schema → classified normally: no degrade finding, Arn stripped.
    expect(findings.some((f) => f.logicalId === 'Q2' && f.note === DEGRADE_NOTE)).toBe(false);
    expect(
      findings.some((f) => f.logicalId === 'Q2' && f.tier === 'undeclared' && f.path === 'Arn')
    ).toBe(false);
  });
});

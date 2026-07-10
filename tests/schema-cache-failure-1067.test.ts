import type { CloudFormationClient as CFNClientType } from '@aws-sdk/client-cloudformation';
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
import { getSchemaInfoResult } from '../src/schema/schema-strip.js';

// #1067: schema-strip DELIBERATELY does not cache a DescribeType FAILURE (#751), but gather's
// per-run `schemas` map used to `schemas.set(resourceType, schema)` whatever came back —
// INCLUDING a failure's EMPTY schema. That poisoned the per-run cache: every LATER resource of
// the same type reused the degraded EMPTY (no readOnly strip → first-run noise; no writeOnly
// readGap → false declared drift; and it broke revert — writeOnlyReincludeOps drops declared
// write-only props, createOnly bars lost) even after the throttle cleared / the permission was
// granted. The fix: getSchemaInfoResult signals `failed`, and gather only caches a SUCCESS.

// A CloudFormationClient-like fake whose `.config.region()` resolves to `region` and whose
// `.send()` is a scriptable mock — proves the `failed` signal without the AWS SDK machinery.
function fakeClient(region: string, send: () => Promise<unknown>): CFNClientType {
  return {
    config: { region: () => Promise.resolve(region) },
    send,
  } as unknown as CFNClientType;
}

describe('getSchemaInfoResult failure signal (#1067)', () => {
  it('reports failed:true on a DescribeType failure and failed:false on success', async () => {
    const resourceType = 'AWS::Foo::Signal1067';
    const region = 'eu-central-1';
    const schema = { properties: { A: { type: 'string' } }, readOnlyProperties: ['/properties/A'] };
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue({ Schema: JSON.stringify(schema) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient(region, send as unknown as () => Promise<unknown>);

    // Failure: EMPTY schema, and failed:true so a caller does not cache it.
    const failed = await getSchemaInfoResult(client, resourceType);
    expect(failed.failed).toBe(true);
    expect(failed.info.readOnly.has('A')).toBe(false);

    // The failure was NOT cached (#751), so the next call re-fetches and succeeds.
    const ok = await getSchemaInfoResult(client, resourceType);
    expect(ok.failed).toBe(false);
    expect(ok.info.readOnly.has('A')).toBe(true);
  });
});

// A stack with TWO resources of the SAME type whose FIRST DescribeType fails and SECOND
// succeeds. The live model carries a schema-readOnly attribute (`ReadOnlyAttr`) the template
// never declares: with the real schema it is stripped (folded), with the EMPTY it surfaces as
// `undeclared`. Before the fix, resource 1's EMPTY poisoned the per-run map → resource 2 reused
// it (never re-fetched) → its ReadOnlyAttr false-surfaced as undeclared AND DescribeType ran
// only ONCE. After the fix, resource 2 re-fetches the now-succeeding schema → clean.
describe('gather does not cache a DescribeType failure in the per-run schemas map (#1067)', () => {
  it('re-fetches for a later resource of the same type after an earlier fetch failed', async () => {
    const ids = ['Q1', 'Q2'];
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: Object.fromEntries(
          ids.map((id) => [id, { Type: 'AWS::SQS::Queue', Properties: { QueueName: `${id}-q` } }])
        ),
      }),
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: ids.map((id) => ({
        LogicalResourceId: id,
        PhysicalResourceId: `${id}-phys`,
        ResourceType: 'AWS::SQS::Queue',
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
    // FIRST DescribeType throws (denied/throttled); SECOND succeeds with a schema that marks
    // the live-only `ReadOnlyAttr` readOnly (so it is stripped, not surfaced as undeclared).
    const okSchema = JSON.stringify({
      properties: { QueueName: { type: 'string' }, ReadOnlyAttr: { type: 'string' } },
      readOnlyProperties: ['/properties/ReadOnlyAttr'],
    });
    const describeType = vi
      .fn()
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue({ Schema: okSchema });
    cfn.on(DescribeTypeCommand).callsFake(describeType);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const cc = mockClient(CloudControlClient);
    // Both queues read back the declared QueueName PLUS an undeclared, schema-readOnly attr.
    cc.on(GetResourceCommand).callsFake((input: { Identifier: string }) => {
      const id = String(input.Identifier).replace('-phys', '');
      return Promise.resolve({
        ResourceDescription: {
          Identifier: input.Identifier,
          Properties: JSON.stringify({ QueueName: `${id}-q`, ReadOnlyAttr: `${id}-ro` }),
        },
      });
    });

    const { findings } = await gatherFindings('S', 'us-east-1');

    // DescribeType was called TWICE — the failure for Q1 was NOT cached, so Q2 re-fetched.
    // Before the fix the poisoned EMPTY short-circuited Q2 and this was 1.
    expect(describeType).toHaveBeenCalledTimes(2);

    // Q1 saw the EMPTY (failed fetch). #858 degrades it to a `skipped` coverage finding
    // instead of diffing against the unstripped model, so the readOnly attr does NOT
    // false-surface as undeclared (before #858 it surfaced `undeclared` — the known-wrong
    // un-schema'd diff this degrade replaces).
    expect(
      findings.some(
        (f) => f.logicalId === 'Q1' && f.tier === 'undeclared' && f.path === 'ReadOnlyAttr'
      )
    ).toBe(false);
    expect(
      findings.some(
        (f) =>
          f.logicalId === 'Q1' &&
          f.tier === 'skipped' &&
          f.note === 'schema unavailable (DescribeType failed) — coverage incomplete'
      )
    ).toBe(true);
    // Q2 re-fetched the REAL schema → its readOnly attr IS stripped → no undeclared finding.
    // Before the fix Q2 reused Q1's poisoned EMPTY and also false-surfaced ReadOnlyAttr.
    expect(
      findings.some(
        (f) => f.logicalId === 'Q2' && f.tier === 'undeclared' && f.path === 'ReadOnlyAttr'
      )
    ).toBe(false);
  });
});

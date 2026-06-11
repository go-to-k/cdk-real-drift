import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeTypeCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { gatherFindings } from '../src/commands/gather.js';

// Build N AWS::SQS::Queue resources whose declared props match the live read, so the
// only differences are ordering-sensitive iteration (no real drift noise).
function makeTemplate(ids: string[]): string {
  const Resources: Record<string, unknown> = {};
  for (const id of ids)
    Resources[id] = { Type: 'AWS::SQS::Queue', Properties: { QueueName: `${id}-q` } };
  return JSON.stringify({ Resources });
}

describe('gatherFindings pass-1 worker pool', () => {
  it('loads every resource and keeps findings order == desired.resources order regardless of read completion order', async () => {
    const ids = ['R0', 'R1', 'R2', 'R3', 'R4'];
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: makeTemplate(ids) });
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
    cfn.on(DescribeTypeCommand).resolves({ Schema: '{}' });

    const cc = mockClient(CloudControlClient);
    const completionOrder: string[] = [];
    // Reverse the read latency so LAST-declared completes FIRST — proves pass-2
    // ordering does not depend on read completion order.
    cc.on(GetResourceCommand).callsFake(async (input: { Identifier: string }) => {
      const id = input.Identifier.replace('-phys', '');
      const idx = ids.indexOf(id);
      await new Promise((r) => setTimeout(r, (ids.length - idx) * 5));
      completionOrder.push(id);
      // live QueueName differs from declared -> a 'declared' drift finding per resource
      return {
        ResourceDescription: {
          Identifier: input.Identifier,
          Properties: JSON.stringify({ QueueName: `${id}-LIVE` }),
        },
      };
    });

    const { desired, findings } = await gatherFindings('S', 'us-east-1');

    // every resource was read
    expect(desired.resources.map((r) => r.logicalId)).toEqual(ids);
    // reads actually completed out of declaration order (worker pool ran concurrently)
    expect(completionOrder).not.toEqual(ids);
    // ...yet findings stay in deterministic desired.resources order
    expect(findings.map((f) => f.logicalId)).toEqual(ids);
  });
});

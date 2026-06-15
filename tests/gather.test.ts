import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeTypeCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from '@aws-sdk/client-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { type GatherResult, gatherFindings, regatherTouched } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import type { Finding, ResolverContext, SchemaInfo } from '../src/types.js';

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

describe('regatherTouched (R44 — scoped post-revert convergence re-gather)', () => {
  const EMPTY_SCHEMA: SchemaInfo = {
    readOnly: new Set(),
    writeOnly: new Set(),
    createOnly: new Set(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
    defaultPaths: {},
  };
  const ctx = (): ResolverContext => ({
    params: {},
    pseudo: {},
    conditions: {},
    physIds: {},
    liveAttrs: {},
    mappings: {},
    exports: {},
    condCache: new Map(),
  });
  const queue = (id: string): Desired['resources'][number] => ({
    logicalId: id,
    resourceType: 'AWS::SQS::Queue',
    physicalId: `${id}-phys`,
    declared: { QueueName: `${id}-q` },
  });
  const gathered = (findings: Finding[]): GatherResult => ({
    desired: {
      stackName: 'S',
      region: 'us-east-1',
      accountId: '111122223333',
      resources: [queue('A'), queue('B')],
      rawTemplate: '{}',
      ctx: ctx(),
    },
    findings,
    schemas: new Map([['AWS::SQS::Queue', EMPTY_SCHEMA]]),
    liveByLogical: new Map(),
  });
  const aFinding = (): Finding => ({
    tier: 'undeclared',
    logicalId: 'A',
    resourceType: 'AWS::SQS::Queue',
    path: 'DelaySeconds',
    physicalId: 'A-phys',
    actual: 30,
  });
  const bFinding = (): Finding => ({
    tier: 'declared',
    logicalId: 'B',
    resourceType: 'AWS::SQS::Queue',
    path: 'QueueName',
    physicalId: 'B-phys',
    desired: 'B-q',
    actual: 'B-LIVE',
  });

  it('re-reads ONLY the touched resources and carries untouched findings forward verbatim', async () => {
    const cc = mockClient(CloudControlClient);
    // B converged (live == declared); A would still read as drifted if it were read
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'B-phys',
        Properties: JSON.stringify({ QueueName: 'B-q' }),
      },
    });

    const g = gathered([aFinding(), bFinding()]);
    const post = await regatherTouched(g, new Set(['B']), 'us-east-1');

    // exactly one read, and it was B — A was never re-read
    const calls = cc.commandCalls(GetResourceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Identifier).toBe('B-phys');
    // A's pre-revert finding survives untouched; B is now clean (no fresh finding)
    expect(post).toEqual([aFinding()]);
  });

  it('a still-drifted touched resource yields a fresh drift finding', async () => {
    const cc = mockClient(CloudControlClient);
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'B-phys',
        Properties: JSON.stringify({ QueueName: 'B-STILL-LIVE' }),
      },
    });

    const post = await regatherTouched(gathered([bFinding()]), new Set(['B']), 'us-east-1');
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      tier: 'declared',
      logicalId: 'B',
      path: 'QueueName',
      actual: 'B-STILL-LIVE',
    });
  });

  it('a touched resource deleted mid-revert surfaces as deleted', async () => {
    const cc = mockClient(CloudControlClient);
    const notFound = new Error('gone');
    notFound.name = 'ResourceNotFoundException';
    cc.on(GetResourceCommand).rejects(notFound);

    const post = await regatherTouched(gathered([bFinding()]), new Set(['B']), 'us-east-1');
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({ tier: 'deleted', logicalId: 'B' });
  });
});

describe('gatherFindings pass-1.5 override retry (R27)', () => {
  const baseCfn = (template: string) => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: template });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Fn',
          PhysicalResourceId: 'Fn-phys',
          ResourceType: 'AWS::Lambda::Function',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE' as const,
        },
        {
          LogicalResourceId: 'Perm',
          PhysicalResourceId: 'Perm-phys',
          ResourceType: 'AWS::Lambda::Permission',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE' as const,
        },
      ],
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
    return cfn;
  };
  const FN_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:Fn-phys';
  // Permission.FunctionName is Fn::GetAtt[Fn, Arn] — unresolvable in pass 1.
  const template = JSON.stringify({
    Resources: {
      Fn: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'Fn-phys' } },
      Perm: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          Action: 'lambda:InvokeFunction',
          Principal: 's3.amazonaws.com',
        },
      },
    },
  });

  it('re-reads a Lambda Permission whose FunctionName GetAtt resolves only after pass 1', async () => {
    baseCfn(template);
    const cc = mockClient(CloudControlClient);
    // the function reads via CC and exposes its Arn -> populates liveAttrs[Fn].Arn
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Identifier: 'Fn-phys', Properties: JSON.stringify({ Arn: FN_ARN }) },
    });
    const lambda = mockClient(LambdaClient);
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          { Action: 'lambda:InvokeFunction', Principal: { Service: 's3.amazonaws.com' } },
        ],
      }),
    });

    const { findings } = await gatherFindings('S', 'us-east-1');

    // the Permission is NO LONGER skipped — pass 1.5 read it with the resolved Arn
    expect(findings.find((f) => f.logicalId === 'Perm' && f.tier === 'skipped')).toBeUndefined();
    // GetPolicy was actually called with the resolved function ARN
    const calls = lambda.commandCalls(LambdaGetPolicyCommand);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.args[0].input.FunctionName === FN_ARN)).toBe(true);
    // declared == live -> the permission is CLEAN (no drift finding for it)
    expect(findings.find((f) => f.logicalId === 'Perm')).toBeUndefined();
  });

  it('leaves the Permission skipped when its FunctionName never resolves', async () => {
    // GetAtt target "Ghost" is not in the template -> unresolved even after pass 1
    const ghostTemplate = JSON.stringify({
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'Fn-phys' } },
        Perm: {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            FunctionName: { 'Fn::GetAtt': ['Ghost', 'Arn'] },
            Action: 'lambda:InvokeFunction',
            Principal: 's3.amazonaws.com',
          },
        },
      },
    });
    baseCfn(ghostTemplate);
    const cc = mockClient(CloudControlClient);
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Identifier: 'Fn-phys', Properties: JSON.stringify({ Arn: FN_ARN }) },
    });
    const lambda = mockClient(LambdaClient);
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: '{"Statement":[]}' });

    const { findings } = await gatherFindings('S', 'us-east-1');
    const perm = findings.find((f) => f.logicalId === 'Perm');
    expect(perm?.tier).toBe('skipped');
    // GetPolicy was never called (the reader bails on the unresolved FunctionName)
    expect(lambda.commandCalls(LambdaGetPolicyCommand)).toHaveLength(0);
  });
});

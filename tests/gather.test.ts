import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  DescribeTypeCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
  LambdaClient,
  GetPolicyCommand as LambdaGetPolicyCommand,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildBucketNotificationManaged,
  buildClusterEchoModels,
  buildSiblingEventBusPolicies,
  buildSiblingManagedPolicyAttachments,
  buildSiblingSgRules,
  buildSiblingUserGroups,
  type GatherResult,
  gatherFindings,
  isDefinitiveNotManaged,
  isManagedBySiblingStack,
  regatherTouched,
  type SiblingCheck,
} from '../src/commands/gather.js';
import type { AddedChild } from '../src/read/child-enumerators.js';
import type { Desired } from '../src/desired/template-adapter.js';
import type { DesiredResource, Finding, ResolverContext, SchemaInfo } from '../src/types.js';

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

  it('re-resolves a CONSUMER whose GetAtt targets a type read only in pass 1.5 (missed-drift FN)', async () => {
    // Q's KmsMasterKeyId is Fn::GetAtt[Perm, Action]. Perm (an SDK_OVERRIDE) is read only
    // in pass 1.5 (its FunctionName GetAtt resolves after pass 1), so liveAttrs[Perm] is
    // populated AFTER the first re-resolution. Without a second re-resolution Q's prop
    // stays UNRESOLVED and its drift is silently skipped. The live Action differs from
    // the live KmsMasterKeyId, so once Q's GetAtt resolves a DECLARED drift must surface.
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
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
          Q: {
            Type: 'AWS::SQS::Queue',
            Properties: { KmsMasterKeyId: { 'Fn::GetAtt': ['Perm', 'Action'] } },
          },
        },
      }),
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Fn',
          PhysicalResourceId: 'Fn-phys',
          ResourceType: 'AWS::Lambda::Function',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
        {
          LogicalResourceId: 'Perm',
          PhysicalResourceId: 'Perm-phys',
          ResourceType: 'AWS::Lambda::Permission',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
        {
          LogicalResourceId: 'Q',
          PhysicalResourceId: 'Q-phys',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
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

    const cc = mockClient(CloudControlClient);
    cc.on(GetResourceCommand, { Identifier: 'Fn-phys' }).resolves({
      ResourceDescription: { Identifier: 'Fn-phys', Properties: JSON.stringify({ Arn: FN_ARN }) },
    });
    cc.on(GetResourceCommand, { Identifier: 'Q-phys' }).resolves({
      ResourceDescription: {
        Identifier: 'Q-phys',
        Properties: JSON.stringify({ KmsMasterKeyId: 'lambda:DIFFERENT' }),
      },
    });
    const lambda = mockClient(LambdaClient);
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          { Action: 'lambda:InvokeFunction', Principal: { Service: 's3.amazonaws.com' } },
        ],
      }),
    });
    lambda.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });

    const { findings } = await gatherFindings('S', 'us-east-1');
    // Q's GetAtt resolved to Perm's live Action ('lambda:InvokeFunction'); live
    // KmsMasterKeyId is 'lambda:DIFFERENT' → a DECLARED drift that would be missed
    // (skipped as unresolved) without the second re-resolution pass.
    const qDrift = findings.find((f) => f.logicalId === 'Q' && f.path === 'KmsMasterKeyId');
    expect(qDrift?.tier).toBe('declared');
    expect(qDrift?.desired).toBe('lambda:InvokeFunction');
    expect(qDrift?.actual).toBe('lambda:DIFFERENT');
  });
});

// A CC composite-identifier resource (ApiGatewayV2 Route) whose PARENT key (ApiId) is
// an Fn::GetAtt is read in pass 1 with the BARE child id (the parent isn't resolved
// yet) → CC returns not-found → a FALSE `deleted`. Pass 1.5 must retry it (it is a
// CC_IDENTIFIER_ADAPTERS type, and the prior outcome was `deleted`) now that liveAttrs
// carries the parent's ApiId, building the composite `apiId|routeId`.
describe('gatherFindings pass-1.5 composite-id retry (GetAtt parent)', () => {
  const template = JSON.stringify({
    Resources: {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'api' } },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: { ApiId: { 'Fn::GetAtt': ['Api', 'ApiId'] }, RouteKey: 'GET /x' },
      },
    },
  });
  const cfnFixture = () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: template });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Api',
          PhysicalResourceId: 'api456',
          ResourceType: 'AWS::ApiGatewayV2::Api',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE' as const,
        },
        {
          LogicalResourceId: 'Route',
          PhysicalResourceId: 'route789',
          ResourceType: 'AWS::ApiGatewayV2::Route',
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

  it('re-reads the Route with the composite id, so it is NOT falsely deleted', async () => {
    cfnFixture();
    const notFound = Object.assign(new Error('not found'), {
      name: 'ResourceNotFoundException',
    });
    const cc = mockClient(CloudControlClient);
    // Api reads by its bare physical id and exposes ApiId -> liveAttrs[Api].ApiId
    cc.on(GetResourceCommand, { Identifier: 'api456' }).resolves({
      ResourceDescription: {
        Identifier: 'api456',
        Properties: JSON.stringify({ ApiId: 'api456', Name: 'api' }),
      },
    });
    // pass 1: bare child id -> not-found (the false-deleted trigger)
    cc.on(GetResourceCommand, { Identifier: 'route789' }).rejects(notFound);
    // pass 1.5: composite id -> the real route (declared == live -> CLEAN)
    cc.on(GetResourceCommand, { Identifier: 'api456|route789' }).resolves({
      ResourceDescription: {
        Identifier: 'api456|route789',
        Properties: JSON.stringify({ ApiId: 'api456', RouteId: 'route789', RouteKey: 'GET /x' }),
      },
    });

    const { findings } = await gatherFindings('S', 'us-east-1');

    // the Route is NEITHER falsely deleted NOR skipped — pass 1.5 read it composite
    expect(findings.find((f) => f.logicalId === 'Route' && f.tier === 'deleted')).toBeUndefined();
    expect(findings.find((f) => f.logicalId === 'Route' && f.tier === 'skipped')).toBeUndefined();
    // CC was actually queried with the composite identifier
    const ids = cc.commandCalls(GetResourceCommand).map((c) => c.args[0].input.Identifier);
    expect(ids).toContain('api456|route789');
    // declared == live -> the Route is CLEAN
    expect(findings.find((f) => f.logicalId === 'Route')).toBeUndefined();
  });
});

describe('gatherFindings pass-1.6 added-enumeration guards an unread parent (WAVE20 F2)', () => {
  it('does NOT false-flag a declared ESM as `added` when the Lambda Function parent read failed', async () => {
    const cfn = mockClient(CloudFormationClient);
    // A Lambda Function parent + a declared EventSourceMapping whose FunctionName is a
    // GetAtt(Fn, Arn) — the common CDK shape, matched only via the parent's live Arn.
    const template = JSON.stringify({
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'fn-name' } },
        Esm: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] },
            EventSourceArn: 'arn:aws:sqs:us-east-1:111122223333:q',
          },
        },
      },
    });
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: template });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Fn',
          PhysicalResourceId: 'fn-name',
          ResourceType: 'AWS::Lambda::Function',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE' as const,
        },
        {
          LogicalResourceId: 'Esm',
          PhysicalResourceId: 'esm-uuid',
          ResourceType: 'AWS::Lambda::EventSourceMapping',
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

    const cc = mockClient(CloudControlClient);
    cc.on(GetResourceCommand).callsFake(async (input: { Identifier: string }) => {
      // The Function parent read FAILS (not a not-found) -> skipped, no liveAttrs[Fn].Arn,
      // and Lambda::Function is not retried in pass 1.5 (no override / id-adapter).
      if (String(input.Identifier).includes('fn-name')) {
        const e = new Error('denied');
        e.name = 'AccessDeniedException';
        throw e;
      }
      // the ESM reads clean (its declared FunctionName GetAtt stays unresolved -> uncompared)
      return {
        ResourceDescription: {
          Identifier: input.Identifier,
          Properties: JSON.stringify({ EventSourceArn: 'arn:aws:sqs:us-east-1:111122223333:q' }),
        },
      };
    });

    const lambda = mockClient(LambdaClient);
    // the live inventory contains exactly the DECLARED ESM (same UUID); before the guard
    // this false-flagged as `added` because fnArn was missing.
    lambda.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [
        { UUID: 'esm-uuid', EventSourceArn: 'arn:aws:sqs:us-east-1:111122223333:q' },
      ],
    });

    const { findings } = await gatherFindings('S', 'us-east-1');
    // the declared ESM is NOT reported as an out-of-band addition...
    expect(findings.some((f) => f.tier === 'added')).toBe(false);
    // ...and the unread parent surfaces its coverage gap as skipped
    expect(findings.some((f) => f.logicalId === 'Fn' && f.tier === 'skipped')).toBe(true);
  });
});

describe('buildSiblingSgRules', () => {
  const desiredWith = (resources: DesiredResource[], accountId = '111122223333'): Desired =>
    ({
      stackName: 's',
      region: 'r',
      accountId,
      resources,
      rawTemplate: '',
      ctx: {} as ResolverContext,
    }) as Desired;

  it('keys rules by the SG GroupId, strips GroupId, and splits ingress/egress', () => {
    const map = buildSiblingSgRules(
      desiredWith([
        {
          logicalId: 'In',
          resourceType: 'AWS::EC2::SecurityGroupIngress',
          physicalId: 'sgr-in',
          declared: {
            GroupId: 'sg-1',
            SourcePrefixListId: 'pl-1',
            IpProtocol: 'tcp',
            FromPort: 3306,
            ToPort: 3306,
          },
        },
        {
          logicalId: 'Out',
          resourceType: 'AWS::EC2::SecurityGroupEgress',
          physicalId: 'sgr-out',
          declared: {
            GroupId: 'sg-1',
            CidrIp: '0.0.0.0/0',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
          },
        },
      ])
    );
    expect(map['sg-1']!.ingress).toEqual([
      { SourcePrefixListId: 'pl-1', IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306 },
    ]);
    expect(map['sg-1']!.egress).toEqual([
      { CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
    ]);
  });

  it('fills SourceSecurityGroupOwnerId with the account id for an SG-ref rule that omits it', () => {
    const map = buildSiblingSgRules(
      desiredWith([
        {
          logicalId: 'Self',
          resourceType: 'AWS::EC2::SecurityGroupIngress',
          physicalId: 'sgr-self',
          declared: {
            GroupId: 'sg-1',
            SourceSecurityGroupId: 'sg-1',
            IpProtocol: 'tcp',
            FromPort: 9000,
            ToPort: 9000,
          },
        },
      ])
    );
    expect(map['sg-1']!.ingress[0]).toMatchObject({
      SourceSecurityGroupId: 'sg-1',
      SourceSecurityGroupOwnerId: '111122223333',
    });
  });

  it('does NOT overwrite a declared (cross-account) SourceSecurityGroupOwnerId', () => {
    const map = buildSiblingSgRules(
      desiredWith([
        {
          logicalId: 'Peer',
          resourceType: 'AWS::EC2::SecurityGroupIngress',
          physicalId: 'sgr-peer',
          declared: {
            GroupId: 'sg-1',
            SourceSecurityGroupId: 'sg-other',
            SourceSecurityGroupOwnerId: '999988887777',
            IpProtocol: 'tcp',
            FromPort: 80,
            ToPort: 80,
          },
        },
      ])
    );
    expect(map['sg-1']!.ingress[0]).toMatchObject({ SourceSecurityGroupOwnerId: '999988887777' });
  });

  it('skips a rule whose GroupId is an unresolved intrinsic (not a concrete string)', () => {
    const map = buildSiblingSgRules(
      desiredWith([
        {
          logicalId: 'In',
          resourceType: 'AWS::EC2::SecurityGroupIngress',
          physicalId: 'sgr-in',
          declared: {
            GroupId: { 'Fn::GetAtt': ['Sg', 'GroupId'] },
            IpProtocol: 'tcp',
            FromPort: 1,
            ToPort: 1,
          },
        },
      ])
    );
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe('buildSiblingEventBusPolicies', () => {
  const desiredWith = (resources: DesiredResource[]): Desired =>
    ({
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources,
      rawTemplate: '',
      ctx: {} as ResolverContext,
    }) as Desired;

  const stmt = {
    Effect: 'Allow',
    Principal: { AWS: '111111111111' },
    Action: 'events:PutEvents',
    Resource: 'arn:aws:events:us-east-1:111111111111:event-bus/CustomBus',
  };

  it('keys a policy by its resolved EventBusName and stamps StatementId as the Sid', () => {
    const map = buildSiblingEventBusPolicies(
      desiredWith([
        {
          logicalId: 'Pol',
          resourceType: 'AWS::Events::EventBusPolicy',
          physicalId: 'CustomBus|Allow',
          declared: {
            EventBusName: 'CustomBus',
            StatementId: 'Allow',
            Statement: stmt,
          },
        },
      ])
    );
    expect(map.CustomBus).toEqual([{ ...stmt, Sid: 'Allow' }]);
  });

  it('does NOT overwrite a Sid the statement already declares', () => {
    const withSid = { ...stmt, Sid: 'InlineSid' };
    const map = buildSiblingEventBusPolicies(
      desiredWith([
        {
          logicalId: 'Pol',
          resourceType: 'AWS::Events::EventBusPolicy',
          physicalId: 'CustomBus|Allow',
          declared: { EventBusName: 'CustomBus', StatementId: 'Allow', Statement: withSid },
        },
      ])
    );
    expect(map.CustomBus![0]).toMatchObject({ Sid: 'InlineSid' });
  });

  it('keys an absent EventBusName under the default bus', () => {
    const map = buildSiblingEventBusPolicies(
      desiredWith([
        {
          logicalId: 'Pol',
          resourceType: 'AWS::Events::EventBusPolicy',
          physicalId: 'p',
          declared: { StatementId: 'Allow', Statement: stmt },
        },
      ])
    );
    expect(map.default).toEqual([{ ...stmt, Sid: 'Allow' }]);
  });

  it('skips a policy whose EventBusName is an unresolved intrinsic', () => {
    const map = buildSiblingEventBusPolicies(
      desiredWith([
        {
          logicalId: 'Pol',
          resourceType: 'AWS::Events::EventBusPolicy',
          physicalId: 'p',
          declared: {
            EventBusName: { Ref: 'Bus' },
            StatementId: 'Allow',
            Statement: stmt,
          },
        },
      ])
    );
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('aggregates multiple policies targeting the same bus', () => {
    const map = buildSiblingEventBusPolicies(
      desiredWith([
        {
          logicalId: 'P1',
          resourceType: 'AWS::Events::EventBusPolicy',
          physicalId: 'CustomBus|A',
          declared: { EventBusName: 'CustomBus', StatementId: 'A', Statement: stmt },
        },
        {
          logicalId: 'P2',
          resourceType: 'AWS::Events::EventBusPolicy',
          physicalId: 'CustomBus|B',
          declared: { EventBusName: 'CustomBus', StatementId: 'B', Statement: stmt },
        },
      ])
    );
    expect(map.CustomBus).toHaveLength(2);
    expect(map.CustomBus!.map((s) => (s as { Sid: string }).Sid)).toEqual(['A', 'B']);
  });
});

describe('buildSiblingManagedPolicyAttachments', () => {
  const desiredWith = (resources: DesiredResource[]): Desired =>
    ({
      stackName: 's',
      region: 'r',
      accountId: '111111111111',
      resources,
      rawTemplate: '',
      ctx: {} as ResolverContext,
    }) as Desired;

  const SIB_ARN = 'arn:aws:iam::111111111111:policy/Stack-SiblingManaged-abc';

  it('keys the sibling ARN by the principal name in Roles/Users/Groups', () => {
    const map = buildSiblingManagedPolicyAttachments(
      desiredWith([
        {
          logicalId: 'SiblingManaged',
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: SIB_ARN,
          declared: { Roles: ['role-phys'], Users: ['user-phys'], Groups: ['group-phys'] },
        },
      ])
    );
    expect(map['role-phys']).toEqual([SIB_ARN]);
    expect(map['user-phys']).toEqual([SIB_ARN]);
    expect(map['group-phys']).toEqual([SIB_ARN]);
  });

  it('resolves a {Ref: logicalId} principal via the logical-id -> physical-id map', () => {
    const map = buildSiblingManagedPolicyAttachments(
      desiredWith([
        {
          logicalId: 'ProbeRole',
          resourceType: 'AWS::IAM::Role',
          physicalId: 'role-phys',
          declared: {},
        },
        {
          logicalId: 'SiblingManaged',
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: SIB_ARN,
          declared: { Roles: [{ Ref: 'ProbeRole' }] },
        },
      ])
    );
    expect(map['role-phys']).toEqual([SIB_ARN]);
  });

  it('falls back to ManagedPolicyName when the policy has no resolved physical id', () => {
    const map = buildSiblingManagedPolicyAttachments(
      desiredWith([
        {
          logicalId: 'SiblingManaged',
          resourceType: 'AWS::IAM::ManagedPolicy',
          declared: { ManagedPolicyName: 'MyPolicy', Roles: ['role-phys'] },
        } as DesiredResource,
      ])
    );
    expect(map['role-phys']).toEqual(['MyPolicy']);
  });

  it('skips a policy with neither an ARN nor a name, and an unresolved principal (fail-open)', () => {
    const map = buildSiblingManagedPolicyAttachments(
      desiredWith([
        {
          logicalId: 'NoId',
          resourceType: 'AWS::IAM::ManagedPolicy',
          declared: { Roles: ['role-phys'] },
        } as DesiredResource,
        {
          logicalId: 'UnresolvedPrincipal',
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: SIB_ARN,
          declared: { Roles: [{ 'Fn::GetAtt': ['X', 'Arn'] }] },
        },
      ])
    );
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe('buildSiblingUserGroups', () => {
  const desiredWith = (resources: DesiredResource[]): Desired =>
    ({
      stackName: 's',
      region: 'r',
      accountId: '111111111111',
      resources,
      rawTemplate: '',
      ctx: {} as ResolverContext,
    }) as Desired;

  it('keys the resolved group name by each user in Users', () => {
    const map = buildSiblingUserGroups(
      desiredWith([
        {
          logicalId: 'Membership',
          resourceType: 'AWS::IAM::UserToGroupAddition',
          declared: { GroupName: 'group-phys', Users: ['user-a', 'user-b'] },
        } as DesiredResource,
      ])
    );
    expect(map['user-a']).toEqual(['group-phys']);
    expect(map['user-b']).toEqual(['group-phys']);
  });

  it('resolves {Ref} for both the group and the user', () => {
    const map = buildSiblingUserGroups(
      desiredWith([
        {
          logicalId: 'ProbeGroup',
          resourceType: 'AWS::IAM::Group',
          physicalId: 'group-phys',
          declared: {},
        },
        {
          logicalId: 'ProbeUser',
          resourceType: 'AWS::IAM::User',
          physicalId: 'user-phys',
          declared: {},
        },
        {
          logicalId: 'Membership',
          resourceType: 'AWS::IAM::UserToGroupAddition',
          declared: { GroupName: { Ref: 'ProbeGroup' }, Users: [{ Ref: 'ProbeUser' }] },
        } as DesiredResource,
      ])
    );
    expect(map['user-phys']).toEqual(['group-phys']);
  });

  it('skips an unresolved group name (fail-open)', () => {
    const map = buildSiblingUserGroups(
      desiredWith([
        {
          logicalId: 'Membership',
          resourceType: 'AWS::IAM::UserToGroupAddition',
          declared: { GroupName: { 'Fn::GetAtt': ['G', 'GroupName'] }, Users: ['user-a'] },
        } as DesiredResource,
      ])
    );
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe('buildBucketNotificationManaged', () => {
  const desiredWith = (resources: DesiredResource[]): Desired =>
    ({
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources,
      rawTemplate: '',
      ctx: {} as ResolverContext,
    }) as Desired;

  it('collects bucket names for a CR with a resolved BucketName and a Ref BucketName', () => {
    const managed = buildBucketNotificationManaged(
      desiredWith([
        {
          logicalId: 'Bucket',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'my-bucket-phys',
          declared: {},
        },
        {
          logicalId: 'NotifResolved',
          resourceType: 'Custom::S3BucketNotifications',
          physicalId: 'cr1',
          declared: { BucketName: 'already-resolved-bucket' },
        },
        {
          logicalId: 'NotifRef',
          resourceType: 'Custom::S3BucketNotifications',
          physicalId: 'cr2',
          declared: { BucketName: { Ref: 'Bucket' } },
        },
      ])
    );
    expect([...managed].sort()).toEqual(['already-resolved-bucket', 'my-bucket-phys']);
  });

  it('skips a CR whose BucketName Ref does not resolve (fail-open)', () => {
    const managed = buildBucketNotificationManaged(
      desiredWith([
        {
          logicalId: 'Notif',
          resourceType: 'Custom::S3BucketNotifications',
          physicalId: 'cr',
          declared: { BucketName: { Ref: 'MissingBucket' } },
        },
      ])
    );
    expect(managed.size).toBe(0);
  });
});

describe('buildClusterEchoModels (#980 — sources parent/child types from CLUSTER_ECHO_CHILD)', () => {
  const desiredWith = (
    resources: DesiredResource[],
    liveAttrs: Record<string, Record<string, unknown>>
  ): Desired =>
    ({
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources,
      rawTemplate: '',
      ctx: { liveAttrs } as unknown as ResolverContext,
    }) as Desired;

  it('maps a Neptune DBInstance to its Neptune DBCluster live model (the live path #980 item 3 needs)', () => {
    const map = buildClusterEchoModels(
      desiredWith(
        [
          {
            logicalId: 'NeptuneCluster',
            resourceType: 'AWS::Neptune::DBCluster',
            physicalId: 'neptune-cluster-1',
            declared: { DBSubnetGroupName: 'neptunedbsubnetgroup-w5v1jnrqmuw8' },
          },
          {
            logicalId: 'NeptuneInstance',
            resourceType: 'AWS::Neptune::DBInstance',
            physicalId: 'neptune-inst-1',
            declared: { DBClusterIdentifier: 'neptune-cluster-1', DBInstanceClass: 'db.r5.large' },
          },
        ],
        { NeptuneCluster: { DBSubnetGroupName: 'neptunedbsubnetgroup-w5v1jnrqmuw8' } }
      )
    );
    expect(map['neptune-inst-1']).toEqual({
      DBSubnetGroupName: 'neptunedbsubnetgroup-w5v1jnrqmuw8',
    });
  });

  it('still maps an RDS DBInstance to its RDS DBCluster live model (no regression)', () => {
    const map = buildClusterEchoModels(
      desiredWith(
        [
          {
            logicalId: 'AuroraCluster',
            resourceType: 'AWS::RDS::DBCluster',
            physicalId: 'aurora-cluster-1',
            declared: {},
          },
          {
            logicalId: 'AuroraInstance',
            resourceType: 'AWS::RDS::DBInstance',
            physicalId: 'aurora-inst-1',
            declared: { DBClusterIdentifier: 'aurora-cluster-1' },
          },
        ],
        { AuroraCluster: { VpcSecurityGroupIds: ['sg-1'] } }
      )
    );
    expect(map['aurora-inst-1']).toEqual({ VpcSecurityGroupIds: ['sg-1'] });
  });

  it('fail-open: an instance whose DBClusterIdentifier does not resolve to a harvested cluster is absent', () => {
    const map = buildClusterEchoModels(
      desiredWith(
        [
          {
            logicalId: 'NeptuneInstance',
            resourceType: 'AWS::Neptune::DBInstance',
            physicalId: 'neptune-inst-1',
            declared: { DBClusterIdentifier: 'some-other-cluster' },
          },
        ],
        {}
      )
    );
    expect(map['neptune-inst-1']).toBeUndefined();
  });
});

describe('isManagedBySiblingStack (#666 cross-stack added FP)', () => {
  const child = (identifier: string, resourceType = 'AWS::SNS::Subscription'): AddedChild => ({
    resourceType,
    identifier,
    label: identifier,
    live: {},
  });
  // The check-run's own account+region — match the ARNs below so a ValidationError is a
  // DEFINITIVE local not-managed (the #959 foreign-scope cases override these deliberately).
  const LOCAL_ACCOUNT = '111122223333';
  const LOCAL_REGION = 'us-east-1';
  const subArn = 'arn:aws:sns:us-east-1:111122223333:NotifTopic:0000-1111-2222';

  it('folds a subscription CDK placed in a SIBLING stack (DescribeStackResources resolves it)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        {
          StackName: 'Producer',
          LogicalResourceId: 'NotifTopicSub',
          PhysicalResourceId: subArn,
          ResourceType: 'AWS::SNS::Subscription',
          Timestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('managed');
  });

  it('does NOT fold a genuinely out-of-band subscription (no owning stack -> API throws)', async () => {
    const cfn = mockClient(CloudFormationClient);
    const notFound = new Error(`Stack for ${subArn} does not exist`);
    notFound.name = 'ValidationError';
    cfn.on(DescribeStackResourcesCommand).rejects(notFound);
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
  });

  it('does NOT fold when the owning-stack resource type differs (id reuse guard)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        {
          StackName: 'Other',
          LogicalResourceId: 'SomethingElse',
          PhysicalResourceId: subArn,
          ResourceType: 'AWS::SNS::Topic',
          Timestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    // the id+type match misses in the first-100 window, so the #726 pagination fallback lists the
    // owning stack; it holds no Subscription with this id either -> not managed.
    cfn.on(ListStackResourcesCommand).resolves({ StackResourceSummaries: [] });
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
  });

  it('skips the API call for a pipe-composite CC identifier (within-stack sub-resource)', async () => {
    const cfn = mockClient(CloudFormationClient);
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child('api123|res456|GET', 'AWS::ApiGateway::Method'),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
    expect(cfn.commandCalls(DescribeStackResourcesCommand)).toHaveLength(0);
  });

  // #895: AWS::Events::Rule's CC identifier is the rule Arn, but its CFn physical id for a
  // rule on a CUSTOM bus is `<busName>|<ruleName>`. The enumerator carries that CFn form on
  // `siblingLookupId`, so the sibling-stack check must look up THAT (not the Arn), or a
  // sibling-managed rule is false-flagged `added` with a destructive DeleteResource offer.
  const ruleArn = 'arn:aws:events:us-east-1:111122223333:rule/MyBus/MyRule';
  const rulePhysicalId = 'MyBus|MyRule'; // CFn physical id for a custom-bus rule

  it('#895: folds a custom-bus Events::Rule a SIBLING stack manages (looks up busName|ruleName, not the Arn)', async () => {
    const cfn = mockClient(CloudFormationClient);
    // CFn only knows the rule by its `<busName>|<ruleName>` physical id — an Arn lookup would miss.
    cfn.on(DescribeStackResourcesCommand).callsFake((input) => {
      if (input.PhysicalResourceId === rulePhysicalId) {
        return {
          StackResources: [
            {
              StackName: 'SiblingStack',
              LogicalResourceId: 'MyRule',
              PhysicalResourceId: rulePhysicalId,
              ResourceType: 'AWS::Events::Rule',
              Timestamp: new Date(0),
              ResourceStatus: 'CREATE_COMPLETE',
            },
          ],
        };
      }
      const notFound = new Error(`Stack for ${input.PhysicalResourceId} does not exist`);
      notFound.name = 'ValidationError';
      throw notFound;
    });
    const rule: AddedChild = {
      resourceType: 'AWS::Events::Rule',
      identifier: ruleArn,
      label: 'MyRule',
      live: {},
      siblingLookupId: rulePhysicalId,
    };
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      rule,
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('managed');
    // it looked up the CFn physical-id form, NOT the CC Arn
    expect(cfn.commandCalls(DescribeStackResourcesCommand)[0]!.args[0].input).toMatchObject({
      PhysicalResourceId: rulePhysicalId,
    });
  });

  it('#895: still reports a genuinely out-of-band custom-bus Events::Rule as added (no owning stack)', async () => {
    const cfn = mockClient(CloudFormationClient);
    const notFound = new Error(`Stack for ${rulePhysicalId} does not exist`);
    notFound.name = 'ValidationError';
    cfn.on(DescribeStackResourcesCommand).rejects(notFound);
    const rule: AddedChild = {
      resourceType: 'AWS::Events::Rule',
      identifier: ruleArn,
      label: 'MyRule',
      live: {},
      siblingLookupId: rulePhysicalId,
    };
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      rule,
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
    // the composite-looking `|` lookup id was NOT short-circuited by the pipe guard: it queried CFn
    expect(cfn.commandCalls(DescribeStackResourcesCommand)).toHaveLength(1);
  });

  it('memoizes the resolution per physical id (one API call for a repeated child)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        {
          StackName: 'Producer',
          LogicalResourceId: 'Sub',
          PhysicalResourceId: subArn,
          ResourceType: 'AWS::SNS::Subscription',
          Timestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    const cache = new Map<string, SiblingCheck>();
    await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      cache,
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      cache,
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(cfn.commandCalls(DescribeStackResourcesCommand)).toHaveLength(1);
    expect(cache.get(subArn)).toBe('managed');
  });

  it('#754: a THROTTLE/denied error returns unverified and is NOT memoized', async () => {
    const cfn = mockClient(CloudFormationClient);
    const throttle = new Error('Rate exceeded');
    throttle.name = 'Throttling';
    cfn.on(DescribeStackResourcesCommand).rejects(throttle);
    const cache = new Map<string, SiblingCheck>();
    const first = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      cache,
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    // a failed check is 'unverified' (the caller reports coverage-incomplete, never a false added)
    expect(first).toBe('unverified');
    // NOT cached -> a later candidate re-attempts (a transient throttle must not poison the run)
    expect(cache.has(subArn)).toBe(false);
    const second = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      cache,
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(second).toBe('unverified');
    expect(cfn.commandCalls(DescribeStackResourcesCommand)).toHaveLength(2);
  });

  it('#726: child BEYOND the DescribeStackResources 100-window resolves via paginated ListStackResources', async () => {
    const cfn = mockClient(CloudFormationClient);
    // DescribeStackResources returns only the first 100 (no pagination), and the child is NOT
    // among them — but every returned resource still names the owning stack.
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        {
          StackName: 'BigProducer',
          LogicalResourceId: 'SomeOther',
          PhysicalResourceId: 'other-phys',
          ResourceType: 'AWS::SQS::Queue',
          Timestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    // ListStackResources paginates: page 1 lacks the child, page 2 (via NextToken) has it.
    cfn
      .on(ListStackResourcesCommand)
      .resolvesOnce({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'Filler',
            PhysicalResourceId: 'filler-phys',
            ResourceType: 'AWS::SQS::Queue',
            LastUpdatedTimestamp: new Date(0),
            ResourceStatus: 'CREATE_COMPLETE',
          },
        ],
        NextToken: 'page2',
      })
      .resolves({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'NotifTopicSub',
            PhysicalResourceId: subArn,
            ResourceType: 'AWS::SNS::Subscription',
            LastUpdatedTimestamp: new Date(0),
            ResourceStatus: 'CREATE_COMPLETE',
          },
        ],
      });
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('managed');
    // it queried the OWNING stack by name and paginated to page 2
    expect(cfn.commandCalls(ListStackResourcesCommand)).toHaveLength(2);
    expect(cfn.commandCalls(ListStackResourcesCommand)[0]!.args[0].input).toMatchObject({
      StackName: 'BigProducer',
    });
  });

  it('#726: a genuinely out-of-band child stays added even after paginating the whole owning-window', async () => {
    // Describe returns 100 without the child; ListStackResources paginates fully and never finds
    // it (it truly belongs to no stack that owns this physical id) -> report as added (fail safe).
    const cfn = mockClient(CloudFormationClient);
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        {
          StackName: 'BigProducer',
          LogicalResourceId: 'X',
          PhysicalResourceId: 'x-phys',
          ResourceType: 'AWS::SQS::Queue',
          Timestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Y',
          PhysicalResourceId: 'y-phys',
          ResourceType: 'AWS::SQS::Queue',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
  });

  // #959: the DescribeStackResources probe runs on the check's OWN account+region client, so a
  // ValidationError only proves the child is not in a stack of THIS scope — a child managed by a
  // stack in a DIFFERENT account/region yields the SAME error but is NOT out of band. It must be
  // 'unverified' (coverage-incomplete, never a destructive DeleteResource), not 'notManaged'.
  it('#959: a CROSS-ACCOUNT-managed subscription (ValidationError, foreign account ARN) is UNVERIFIED, not added', async () => {
    const cfn = mockClient(CloudFormationClient);
    // The subscription ARN's account (999988887777) differs from the check's account.
    const foreignAccountArn = 'arn:aws:sns:us-east-1:999988887777:NotifTopic:aaaa-bbbb-cccc';
    const notFound = new Error(`Stack for ${foreignAccountArn} does not exist`);
    notFound.name = 'ValidationError';
    cfn.on(DescribeStackResourcesCommand).rejects(notFound);
    const cache = new Map<string, SiblingCheck>();
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(foreignAccountArn),
      cache,
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    // fail safe: unverifiable, so NOT a destructive-deletable `added`
    expect(managed).toBe('unverified');
    // and NOT memoized as notManaged (uniform with the other unverifiable cases)
    expect(cache.has(foreignAccountArn)).toBe(false);
  });

  it('#959: a CROSS-REGION-managed subscription (ValidationError, foreign region ARN) is UNVERIFIED, not added', async () => {
    const cfn = mockClient(CloudFormationClient);
    // Same account, but the topic/subscription live in eu-west-1 while the check runs in us-east-1.
    const foreignRegionArn = 'arn:aws:sns:eu-west-1:111122223333:NotifTopic:dddd-eeee-ffff';
    const notFound = new Error(`Stack for ${foreignRegionArn} does not exist`);
    notFound.name = 'ValidationError';
    cfn.on(DescribeStackResourcesCommand).rejects(notFound);
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(foreignRegionArn),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('unverified');
  });

  it('#959: a genuinely out-of-band SAME-account+region subscription is STILL added (ValidationError, local ARN)', async () => {
    const cfn = mockClient(CloudFormationClient);
    // subArn is arn:aws:sns:us-east-1:111122223333:... — exactly the check's account+region.
    const notFound = new Error(`Stack for ${subArn} does not exist`);
    notFound.name = 'ValidationError';
    cfn.on(DescribeStackResourcesCommand).rejects(notFound);
    const cache = new Map<string, SiblingCheck>();
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      child(subArn),
      cache,
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    // a real local out-of-band addition is verifiable and MUST still surface (and be cached)
    expect(managed).toBe('notManaged');
    expect(cache.get(subArn)).toBe('notManaged');
  });

  describe('isDefinitiveNotManaged (#959 foreign-scope classifier)', () => {
    it('a same-account+region ARN is definitive (safe to report added)', () => {
      expect(isDefinitiveNotManaged(subArn, LOCAL_ACCOUNT, LOCAL_REGION)).toBe(true);
    });
    it('a foreign-account ARN is NOT definitive (unverifiable)', () => {
      expect(
        isDefinitiveNotManaged(
          'arn:aws:sns:us-east-1:999988887777:T:x',
          LOCAL_ACCOUNT,
          LOCAL_REGION
        )
      ).toBe(false);
    });
    it('a foreign-region ARN is NOT definitive (unverifiable)', () => {
      expect(
        isDefinitiveNotManaged(
          'arn:aws:sns:eu-west-1:111122223333:T:x',
          LOCAL_ACCOUNT,
          LOCAL_REGION
        )
      ).toBe(false);
    });
    it('a non-ARN physical id (bare name/UUID minted in this scope) is definitive', () => {
      expect(isDefinitiveNotManaged('MyBus|MyRule', LOCAL_ACCOUNT, LOCAL_REGION)).toBe(true);
      expect(isDefinitiveNotManaged('some-bare-name', LOCAL_ACCOUNT, LOCAL_REGION)).toBe(true);
    });
    it('an ARN with an empty region/account segment carries no foreign signal (definitive)', () => {
      // e.g. a global/partition-scoped ARN like arn:aws:iam::111122223333:role/... (no region).
      expect(
        isDefinitiveNotManaged('arn:aws:iam::111122223333:role/R', LOCAL_ACCOUNT, LOCAL_REGION)
      ).toBe(true);
    });
  });
});

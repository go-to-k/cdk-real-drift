import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListExportsCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildResolverContext,
  collectRolesWithSiblingPolicies,
  loadDesired,
  parseTemplateBody,
} from '../src/desired/template-adapter.js';

describe('collectRolesWithSiblingPolicies', () => {
  it('maps roles referenced by sibling AWS::IAM::Policy resources to the policy NAMES', () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      MyPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'MyRoleDefaultPolicyABC', Roles: [{ Ref: 'MyRole' }] },
      },
      ExtraPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'extra', Roles: [{ Ref: 'MyRole' }] },
      },
      Other: { Type: 'AWS::S3::Bucket' },
    };
    expect(collectRolesWithSiblingPolicies(resources)).toEqual(
      new Map([['MyRole', ['MyRoleDefaultPolicyABC', 'extra']]])
    );
  });

  it('ignores non-Ref role entries and non-policy resources', () => {
    const resources = {
      P: { Type: 'AWS::IAM::Policy', Properties: { PolicyName: 'p', Roles: ['literal-name'] } },
      Q: { Type: 'AWS::IAM::ManagedPolicy', Properties: { Roles: [{ Ref: 'R' }] } },
    };
    expect(collectRolesWithSiblingPolicies(resources).size).toBe(0); // literal not a Ref; ManagedPolicy not Policy
  });

  it("marks the role 'unresolved' when a sibling PolicyName cannot be resolved (sticky)", () => {
    const resources = {
      A: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'literal', Roles: [{ Ref: 'MyRole' }] },
      },
      B: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: { 'Fn::GetAtt': ['X', 'Y'] }, Roles: [{ Ref: 'MyRole' }] },
      },
      C: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'after', Roles: [{ Ref: 'MyRole' }] },
      },
    };
    // no ctx -> the intrinsic cannot resolve; 'unresolved' wins and stays
    expect(collectRolesWithSiblingPolicies(resources).get('MyRole')).toBe('unresolved');
  });

  it('resolves an intrinsic PolicyName when a resolver ctx is provided', () => {
    const resources = {
      P: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: { 'Fn::Sub': 'pol-${AWS::Region}' },
          Roles: [{ Ref: 'MyRole' }],
        },
      },
    };
    const ctx = buildResolverContext({}, {}, {}, 'us-east-1', '111122223333', 's', 'sid');
    expect(collectRolesWithSiblingPolicies(resources, ctx).get('MyRole')).toEqual([
      'pol-us-east-1',
    ]);
  });
});

describe('buildResolverContext', () => {
  it('merges template defaults with deployed params (deployed wins) + sets pseudo', () => {
    const template = {
      Parameters: { Env: { Default: 'dev' }, Other: { Default: 'x' } },
      Conditions: { C: true },
      Mappings: { RegionMap: { 'us-west-2': { ami: 'ami-1' } } },
    };
    const ctx = buildResolverContext(
      template,
      { Env: 'prod' },
      { Log: 'phys' },
      'us-west-2',
      '999',
      'S',
      'arn:stack'
    );
    expect(ctx.params.Env).toBe('prod'); // deployed value wins
    expect(ctx.params.Other).toBe('x'); // template default kept
    expect(ctx.pseudo['AWS::Region']).toBe('us-west-2');
    expect(ctx.pseudo['AWS::AccountId']).toBe('999');
    expect(ctx.physIds.Log).toBe('phys');
    expect(ctx.conditions.C).toBe(true);
    expect(ctx.mappings.RegionMap['us-west-2'].ami).toBe('ami-1'); // Mappings carried for FindInMap
    expect(ctx.exports).toEqual({}); // empty until loadDesired prefetches (only when needed)
  });
});

describe('parseTemplateBody', () => {
  it('parses JSON and YAML bodies', () => {
    expect(parseTemplateBody('{"Resources":{}}')).toEqual({ Resources: {} });
    expect(parseTemplateBody('Resources: {}')).toEqual({ Resources: {} });
  });
});

describe('loadDesired templateOverride (--pre-deploy)', () => {
  it('uses the override template as the declared source and skips GetTemplate', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Bucket',
          PhysicalResourceId: 'b-phys',
          ResourceType: 'AWS::S3::Bucket',
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

    const synthTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'from-synth' } } },
    };
    const desired = await loadDesired(
      cfn as unknown as CloudFormationClient,
      'S',
      'us-east-1',
      synthTemplate
    );
    expect(desired.resources).toHaveLength(1);
    expect(desired.resources[0]!.declared).toEqual({ BucketName: 'from-synth' });
    expect(desired.resources[0]!.physicalId).toBe('b-phys'); // physId still from live stack
    expect(desired.accountId).toBe('111122223333');
  });
});

describe('loadDesired ListStackResources pagination', () => {
  it('pages NextToken and loads every resource (>100-resource stacks)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: {
          A: { Type: 'AWS::S3::Bucket', Properties: {} },
          B: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      }),
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
    // page 1 -> NextToken, page 2 -> last page
    cfn
      .on(ListStackResourcesCommand, { StackName: 'S', NextToken: undefined })
      .resolves({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'A',
            PhysicalResourceId: 'a-phys',
            ResourceType: 'AWS::S3::Bucket',
            LastUpdatedTimestamp: new Date(0),
            ResourceStatus: 'CREATE_COMPLETE',
          },
        ],
        NextToken: 'p2',
      })
      .on(ListStackResourcesCommand, { StackName: 'S', NextToken: 'p2' })
      .resolves({
        StackResourceSummaries: [
          {
            LogicalResourceId: 'B',
            PhysicalResourceId: 'b-phys',
            ResourceType: 'AWS::S3::Bucket',
            LastUpdatedTimestamp: new Date(0),
            ResourceStatus: 'CREATE_COMPLETE',
          },
        ],
      });

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1');
    const ids = Object.fromEntries(desired.resources.map((r) => [r.logicalId, r.physicalId]));
    expect(ids).toEqual({ A: 'a-phys', B: 'b-phys' }); // both pages loaded
  });
});

describe('loadDesired Fn::ImportValue exports prefetch', () => {
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
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/IV/x',
          StackName: 'IV',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
  }

  it('prefetches (paginated) + resolves Fn::ImportValue when the template references it', async () => {
    const cfn = mockClient(CloudFormationClient);
    stackMocks(
      cfn,
      JSON.stringify({
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', Properties: { Tag: { 'Fn::ImportValue': 'SharedArn' } } },
        },
      })
    );
    cfn
      .on(ListExportsCommand, { NextToken: undefined })
      .resolves({ Exports: [{ Name: 'Other', Value: 'o' }], NextToken: 'e2' })
      .on(ListExportsCommand, { NextToken: 'e2' })
      .resolves({ Exports: [{ Name: 'SharedArn', Value: 'arn:aws:x:::shared' }] });

    // distinct region per test so the module-level exports cache can't cross-contaminate
    const desired = await loadDesired(
      cfn as unknown as CloudFormationClient,
      'IV',
      'ap-northeast-1'
    );
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'arn:aws:x:::shared' });
  });

  it('does NOT call ListExports when the template has no Fn::ImportValue', async () => {
    const cfn = mockClient(CloudFormationClient);
    stackMocks(
      cfn,
      JSON.stringify({
        Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { Tag: 'static' } } },
      })
    );
    cfn.on(ListExportsCommand).rejects(new Error('ListExports must NOT be called'));

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'IV', 'eu-west-1');
    expect(desired.resources[0]!.declared).toEqual({ Tag: 'static' });
  });
});

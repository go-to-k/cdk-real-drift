import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
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
  it('finds roles referenced by a sibling AWS::IAM::Policy', () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      MyPolicy: { Type: 'AWS::IAM::Policy', Properties: { Roles: [{ Ref: 'MyRole' }] } },
      Other: { Type: 'AWS::S3::Bucket' },
    };
    expect([...collectRolesWithSiblingPolicies(resources)]).toEqual(['MyRole']);
  });

  it('ignores non-Ref role entries and non-policy resources', () => {
    const resources = {
      P: { Type: 'AWS::IAM::Policy', Properties: { Roles: ['literal-name'] } },
      Q: { Type: 'AWS::IAM::ManagedPolicy', Properties: { Roles: [{ Ref: 'R' }] } },
    };
    expect(collectRolesWithSiblingPolicies(resources).size).toBe(0); // literal not a Ref; ManagedPolicy not Policy
  });
});

describe('buildResolverContext', () => {
  it('merges template defaults with deployed params (deployed wins) + sets pseudo', () => {
    const template = {
      Parameters: { Env: { Default: 'dev' }, Other: { Default: 'x' } },
      Conditions: { C: true },
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
    cfn.on(DescribeStackResourcesCommand).resolves({
      StackResources: [
        {
          LogicalResourceId: 'Bucket',
          PhysicalResourceId: 'b-phys',
          ResourceType: 'AWS::S3::Bucket',
          Timestamp: new Date(0),
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

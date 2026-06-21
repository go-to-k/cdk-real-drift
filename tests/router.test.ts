import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { readLive } from '../src/read/router.js';
import type { DesiredResource } from '../src/types.js';

const cc = mockClient(CloudControlClient);
const s3 = mockClient(S3Client);

const named = (name: string): Error => Object.assign(new Error(name), { name });

const res = (over: Partial<DesiredResource> = {}): DesiredResource => ({
  logicalId: 'L',
  resourceType: 'AWS::DynamoDB::Table',
  physicalId: 'phys',
  declared: {},
  ...over,
});

beforeEach(() => {
  cc.reset();
  s3.reset();
});

describe('readLive (CC API path)', () => {
  it('parses the live model on success', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"BillingMode":"PAY_PER_REQUEST"}' },
    });
    const r = await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(r.live).toEqual({ BillingMode: 'PAY_PER_REQUEST' });
    expect(r.deleted).toBeUndefined();
  });

  it('maps ResourceNotFoundException to deleted (out-of-band deletion)', async () => {
    cc.on(GetResourceCommand).rejects(named('ResourceNotFoundException'));
    const r = await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(r.deleted).toBe(true);
    expect(r.live).toBeUndefined();
    expect(r.skippedReason).toBeUndefined();
  });

  it('maps any OTHER CC error to skipped, not deleted', async () => {
    cc.on(GetResourceCommand).rejects(named('ThrottlingException'));
    const r = await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(r.deleted).toBeUndefined();
    expect(r.skippedReason).toContain('ThrottlingException');
  });
});

describe('readLive (CC identifier adapters, R74)', () => {
  const sent = (): string =>
    (cc.commandCalls(GetResourceCommand)[0]?.args[0].input.Identifier ?? '') as string;

  it('AppSync GraphQLApi: the ARN physical id is reduced to the bare ApiId', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AppSync::GraphQLApi',
        physicalId: 'arn:aws:appsync:us-east-1:111111111111:apis/abc123xyz',
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('abc123xyz');
  });

  it('AppSync GraphQLApi: a non-ARN physical id passes through unchanged', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::AppSync::GraphQLApi', physicalId: 'abc123xyz' }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('abc123xyz');
  });

  it('Batch JobDefinition: the ARN physical id is reduced to the bare name (no :revision)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Batch::JobDefinition',
        physicalId: 'arn:aws:batch:us-east-1:111111111111:job-definition/MyJobDef-abc:3',
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('MyJobDef-abc');
  });

  it('Batch JobDefinition: a bare name with a :revision suffix is also stripped', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::Batch::JobDefinition', physicalId: 'MyJobDef-abc:3' }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('MyJobDef-abc');
  });

  it('Cognito UserPoolClient: builds the composite UserPoolId|ClientId identifier', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Cognito::UserPoolClient',
        physicalId: 'client123',
        declared: { UserPoolId: 'us-east-1_AbCdEf' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('us-east-1_AbCdEf|client123');
  });

  it('Cognito UserPoolGroup: builds the composite UserPoolId|GroupName identifier (R84)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Cognito::UserPoolGroup',
        physicalId: 'admins',
        declared: { UserPoolId: 'us-east-1_AbCdEf' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('us-east-1_AbCdEf|admins');
  });

  it('Cognito UserPoolClient: an unresolved UserPoolId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::Cognito::UserPoolClient', physicalId: 'client123', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('client123');
  });

  it('ECS Service: builds the composite ServiceArn|Cluster identifier — service FIRST (R102)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ECS::Service',
        physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/my-cluster/my-svc',
        declared: { Cluster: 'my-cluster' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('arn:aws:ecs:us-east-1:111111111111:service/my-cluster/my-svc|my-cluster');
  });

  it('ECS Service: an unresolved Cluster falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ECS::Service',
        physicalId: 'arn:aws:ecs:us-east-1:111111111111:service/my-cluster/my-svc',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('arn:aws:ecs:us-east-1:111111111111:service/my-cluster/my-svc');
  });

  it('types without an adapter keep the physical id as the identifier', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(sent()).toBe('phys');
  });

  // R76: ApiGatewayV2 Stage/Route/Integration composite [ApiId, <child id>].
  for (const t of [
    'AWS::ApiGatewayV2::Stage',
    'AWS::ApiGatewayV2::Route',
    'AWS::ApiGatewayV2::Integration',
  ]) {
    it(`${t}: builds the ApiId|<child> composite identifier`, async () => {
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({ resourceType: t, physicalId: 'child123', declared: { ApiId: 'api456' } }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('api456|child123');
    });
  }

  it('ApiGatewayV2 Authorizer: builds the AuthorizerId|ApiId composite — CHILD first (reverse of its siblings)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::Authorizer',
        physicalId: 'auth123',
        declared: { ApiId: 'api456' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('auth123|api456');
  });

  it('ApiGatewayV2 Authorizer: an unresolved ApiId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::ApiGatewayV2::Authorizer', physicalId: 'auth123', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('auth123');
  });

  it('ApiGatewayV2 Stage: an unresolved ApiId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::ApiGatewayV2::Stage', physicalId: 'live', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('live');
  });

  it('ApiGatewayV2 Route: an already-composite physical id is not double-prefixed', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::Route',
        physicalId: 'api456|route789',
        declared: { ApiId: 'api456' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('api456|route789');
  });

  // R129: ApiGateway v1 (REST) parent-first [RestApiId, <child>] + Cognito
  // [UserPoolId, <child>] composites — verified live (skipped 7 -> 0 on the ccadapters
  // fixture). The CFn physical id carries only the child; the parent is the resolved Ref.
  for (const t of [
    'AWS::ApiGateway::Model',
    'AWS::ApiGateway::RequestValidator',
    'AWS::ApiGateway::Resource',
    'AWS::ApiGateway::Stage',
    'AWS::ApiGateway::Authorizer',
  ]) {
    it(`${t}: builds the RestApiId|<child> composite identifier`, async () => {
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({ resourceType: t, physicalId: 'child123', declared: { RestApiId: 'api456' } }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('api456|child123');
    });
  }

  for (const t of [
    'AWS::Cognito::UserPoolDomain',
    'AWS::Cognito::UserPoolResourceServer',
    'AWS::Cognito::UserPoolIdentityProvider',
  ]) {
    it(`${t}: builds the UserPoolId|<child> composite identifier`, async () => {
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({ resourceType: t, physicalId: 'child123', declared: { UserPoolId: 'us-east-1_AbC' } }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('us-east-1_AbC|child123');
    });
  }

  it('ApiGateway Model: an unresolved RestApiId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::ApiGateway::Model', physicalId: 'm1', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('m1');
  });

  // R129: ApiGateway::Deployment is CHILD-first [DeploymentId, RestApiId] — verified
  // live that `RestApiId|DeploymentId` returns not-found; only `DeploymentId|RestApiId`
  // reads. The CFn physical id is the DeploymentId.
  it('ApiGateway Deployment: builds the DeploymentId|RestApiId composite — child FIRST', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGateway::Deployment',
        physicalId: 'dep123',
        declared: { RestApiId: 'api456' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('dep123|api456');
  });

  it('ApiGateway Deployment: an unresolved RestApiId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::ApiGateway::Deployment', physicalId: 'dep123', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('dep123');
  });

  // R77: AppConfig Environment/ConfigurationProfile composite [ApplicationId, <child id>].
  for (const t of ['AWS::AppConfig::Environment', 'AWS::AppConfig::ConfigurationProfile']) {
    it(`${t}: builds the ApplicationId|<child> composite identifier`, async () => {
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({ resourceType: t, physicalId: 'envOrProfile1', declared: { ApplicationId: 'app99' } }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('app99|envOrProfile1');
    });
  }

  it('AppConfig Environment: an unresolved ApplicationId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::AppConfig::Environment', physicalId: 'env1', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('env1');
  });

  // R79: ApplicationAutoScaling ScalingPolicy [Arn, ScalableDimension] — the
  // dimension is parsed from the resolved ScalingTargetId (the ScalableTarget
  // physical id `resourceId|scalableDimension|serviceNamespace`).
  it('ScalingPolicy: composes PolicyARN|ScalableDimension from ScalingTargetId', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    const policyArn =
      'arn:aws:autoscaling:us-east-1:1:scalingPolicy:abc:resource/dynamodb/table/T:policyName/p';
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApplicationAutoScaling::ScalingPolicy',
        physicalId: policyArn,
        declared: { ScalingTargetId: 'table/T|dynamodb:table:ReadCapacityUnits|dynamodb' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe(`${policyArn}|dynamodb:table:ReadCapacityUnits`);
  });

  it('ScalingPolicy: an unresolved ScalingTargetId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApplicationAutoScaling::ScalingPolicy',
        physicalId: 'arn:x',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('arn:x');
  });
});

describe('readLive (custom resources short-circuit, R26)', () => {
  it('returns skipped WITHOUT calling Cloud Control for a Custom:: resource', async () => {
    const r = await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'Custom::S3AutoDeleteObjects' }),
      'us-east-1',
      '1'
    );
    expect(r.skippedReason).toContain('custom resource');
    expect(r.live).toBeUndefined();
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(0); // no wasted API call
  });

  it('also short-circuits AWS::CloudFormation::CustomResource', async () => {
    const r = await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::CloudFormation::CustomResource' }),
      'us-east-1',
      '1'
    );
    expect(r.skippedReason).toContain('custom resource');
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(0);
  });
});

describe('readLive (SDK override path)', () => {
  const bucketPolicy = res({
    resourceType: 'AWS::S3::BucketPolicy',
    declared: { Bucket: 'my-bucket' },
  });

  it('maps an override not-found error (NoSuchBucketPolicy) to deleted', async () => {
    s3.on(GetBucketPolicyCommand).rejects(named('NoSuchBucketPolicy'));
    const r = await readLive(cc as unknown as CloudControlClient, bucketPolicy, 'us-east-1', '1');
    expect(r.deleted).toBe(true);
  });

  it('maps any OTHER override error to skipped, not deleted', async () => {
    s3.on(GetBucketPolicyCommand).rejects(named('AccessDenied'));
    const r = await readLive(cc as unknown as CloudControlClient, bucketPolicy, 'us-east-1', '1');
    expect(r.deleted).toBeUndefined();
    expect(r.skippedReason).toContain('AccessDenied');
  });

  it('returns skipped (not deleted) when the override cannot resolve its target', async () => {
    const r = await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::S3::BucketPolicy', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(r.deleted).toBeUndefined();
    expect(r.skippedReason).toContain('not resolvable');
  });
});

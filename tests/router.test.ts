import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { DescribeParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  DescribeUsersCommand as DescribeCacheUsersCommand,
  ElastiCacheClient,
} from '@aws-sdk/client-elasticache';
import {
  DescribeUsersCommand as DescribeMemoryDbUsersCommand,
  MemoryDBClient,
} from '@aws-sdk/client-memorydb';
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs';
import {
  ElasticLoadBalancingV2Client,
  GetTrustStoreCaCertificatesBundleCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribeConfigurationCommand,
  DescribeConfigurationRevisionCommand,
  KafkaClient,
} from '@aws-sdk/client-kafka';
import { GetWorkgroupCommand, RedshiftServerlessClient } from '@aws-sdk/client-redshift-serverless';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readLive } from '../src/read/router.js';
import type { DesiredResource } from '../src/types.js';

const cc = mockClient(CloudControlClient);
const s3 = mockClient(S3Client);
const ssm = mockClient(SSMClient);
const elasticache = mockClient(ElastiCacheClient);
const ecs = mockClient(ECSClient);
const memorydb = mockClient(MemoryDBClient);
const redshiftServerless = mockClient(RedshiftServerlessClient);
const kafka = mockClient(KafkaClient);
const elbv2 = mockClient(ElasticLoadBalancingV2Client);

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
  ssm.reset();
  elasticache.reset();
  ecs.reset();
  memorydb.reset();
  redshiftServerless.reset();
  kafka.reset();
  elbv2.reset();
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

  it('ECR RepositoryCreationTemplate: a trailing-slash Prefix physical id is stripped to the stored id (#502)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::ECR::RepositoryCreationTemplate', physicalId: 'cdkrd-hunt/' }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('cdkrd-hunt');
  });

  it('ECR RepositoryCreationTemplate: the literal ROOT prefix (no slash) passes through (#502)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::ECR::RepositoryCreationTemplate', physicalId: 'ROOT' }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('ROOT');
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

  // R76 + #872: ApiGatewayV2 Stage/Route/Integration/Model/Deployment composite
  // [ApiId, <child id>].
  for (const t of [
    'AWS::ApiGatewayV2::Stage',
    'AWS::ApiGatewayV2::Route',
    'AWS::ApiGatewayV2::Integration',
    'AWS::ApiGatewayV2::Model',
    'AWS::ApiGatewayV2::Deployment',
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

  it('ApiGatewayV2 IntegrationResponse: builds the ApiId|IntegrationId|IntegrationResponseId 3-segment composite (#872)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::IntegrationResponse',
        physicalId: 'intresp789',
        declared: { ApiId: 'api456', IntegrationId: 'integ123' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('api456|integ123|intresp789');
  });

  it('ApiGatewayV2 IntegrationResponse: an unresolved parent (missing IntegrationId) falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::IntegrationResponse',
        physicalId: 'intresp789',
        declared: { ApiId: 'api456' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('intresp789');
  });

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

  it('AutoScaling LifecycleHook: builds the AutoScalingGroupName|LifecycleHookName composite', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AutoScaling::LifecycleHook',
        physicalId: 'my-hook',
        declared: { AutoScalingGroupName: 'my-asg' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('my-asg|my-hook');
  });

  it('CodeDeploy DeploymentGroup: builds the ApplicationName|DeploymentGroupName composite — parent first', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::CodeDeploy::DeploymentGroup',
        physicalId: 'cdkrd-readgap-dg',
        declared: { ApplicationName: 'my-app' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('my-app|cdkrd-readgap-dg');
  });

  it('CodeDeploy DeploymentGroup: an unresolved ApplicationName falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::CodeDeploy::DeploymentGroup',
        physicalId: 'cdkrd-readgap-dg',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('cdkrd-readgap-dg');
  });

  it('GuardDuty Filter: builds the DetectorId|Name composite — PARENT first (#878)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::GuardDuty::Filter',
        physicalId: 'my-filter',
        declared: { DetectorId: 'abc123detector' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('abc123detector|my-filter');
  });

  it('GuardDuty Filter: an unresolved DetectorId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::GuardDuty::Filter',
        physicalId: 'my-filter',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('my-filter');
  });

  it('AutoScaling ScheduledAction: builds the ScheduledActionName|AutoScalingGroupName composite — CHILD first (reverse of LifecycleHook)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AutoScaling::ScheduledAction',
        physicalId: 'my-action',
        declared: { AutoScalingGroupName: 'my-asg' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('my-action|my-asg');
  });

  it('AutoScaling ScheduledAction: an unresolved ASG name falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AutoScaling::ScheduledAction',
        physicalId: 'my-action',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('my-action');
  });

  it('Logs SubscriptionFilter: builds the FilterName|LogGroupName composite — CHILD first', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Logs::SubscriptionFilter',
        physicalId: 'cdkrd-errors',
        declared: { LogGroupName: '/aws/my-log-group' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('cdkrd-errors|/aws/my-log-group');
  });

  it('Logs SubscriptionFilter: an unresolved LogGroupName falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Logs::SubscriptionFilter',
        physicalId: 'cdkrd-errors',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('cdkrd-errors');
  });

  it('Logs LogStream: builds the LogGroupName|LogStreamName composite — PARENT first', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::Logs::LogStream',
        physicalId: 'my-stream',
        declared: { LogGroupName: '/aws/my-log-group' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('/aws/my-log-group|my-stream');
  });

  it('Logs LogStream: an unresolved LogGroupName falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({ resourceType: 'AWS::Logs::LogStream', physicalId: 'my-stream', declared: {} }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('my-stream');
  });

  for (const t of [
    'AWS::SSM::MaintenanceWindowTarget',
    'AWS::SSM::MaintenanceWindowTask',
  ] as const) {
    it(`${t}: builds the WindowId|<childId> composite — PARENT first (#528)`, async () => {
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({
          resourceType: t,
          physicalId: '2e28d55f-197f-458f-8cc5-1883bfb37fea',
          declared: { WindowId: 'mw-084705ae45cc003ec' },
        }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('mw-084705ae45cc003ec|2e28d55f-197f-458f-8cc5-1883bfb37fea');
    });

    it(`${t}: an unresolved WindowId falls back to the raw physical id`, async () => {
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({ resourceType: t, physicalId: 'child-uuid', declared: {} }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('child-uuid');
    });
  }

  for (const t of [
    'AWS::Cognito::UserPoolDomain',
    'AWS::Cognito::UserPoolResourceServer',
    'AWS::Cognito::UserPoolIdentityProvider',
    // UserPoolUser [UserPoolId, Username] — parent-first; CFn Ref is the bare Username,
    // so without the adapter the user is a CC ValidationException skip (read-gap).
    // Verified live (cognito-userpooluser-rich): UserPoolId|Username reads, reverse 404s.
    'AWS::Cognito::UserPoolUser',
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

  // #493: ElasticBeanstalk ConfigurationTemplate [ApplicationName, TemplateName] —
  // parent-first. CFn physical id is the bare TemplateName; without the adapter it is a
  // CC ValidationException skip. Verified live: ApplicationName|TemplateName reads, reverse 404s.
  it('ElasticBeanstalk ConfigurationTemplate: builds the ApplicationName|TemplateName composite — PARENT first', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ElasticBeanstalk::ConfigurationTemplate',
        physicalId: 'MyStack-EbTemplate-1CZ1zQUn5g9T',
        declared: { ApplicationName: 'cdkrd-hunt-ebapp' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('cdkrd-hunt-ebapp|MyStack-EbTemplate-1CZ1zQUn5g9T');
  });

  it('ElasticBeanstalk ConfigurationTemplate: an unresolved ApplicationName falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ElasticBeanstalk::ConfigurationTemplate',
        physicalId: 'MyStack-EbTemplate-1CZ1zQUn5g9T',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('MyStack-EbTemplate-1CZ1zQUn5g9T');
  });

  // #493 (by analogy): ApplicationVersion [ApplicationName, Id] — parent-first, same shape.
  it('ElasticBeanstalk ApplicationVersion: builds the ApplicationName|Id composite — PARENT first', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ElasticBeanstalk::ApplicationVersion',
        physicalId: 'v-1a2b3c',
        declared: { ApplicationName: 'cdkrd-hunt-ebapp' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('cdkrd-hunt-ebapp|v-1a2b3c');
  });

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

  // ApiGateway::DocumentationPart is CHILD-first [DocumentationPartId, RestApiId] —
  // verified live (cognito/apigw-rest-subres hunt) that `RestApiId|DocumentationPartId`
  // returns NotFound; only `DocumentationPartId|RestApiId` reads. Without the adapter the
  // bare DocumentationPartId is a CC ValidationException skip (read-gap).
  it('ApiGateway DocumentationPart: builds the DocumentationPartId|RestApiId composite — child FIRST', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGateway::DocumentationPart',
        physicalId: '9dgubo',
        declared: { RestApiId: 'api456' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('9dgubo|api456');
  });

  it('ApiGateway DocumentationPart: an unresolved RestApiId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGateway::DocumentationPart',
        physicalId: '9dgubo',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('9dgubo');
  });

  // TransitGatewayRouteTablePropagation: composite [TransitGatewayRouteTableId,
  // TransitGatewayAttachmentId] built from TWO declared props (the CFn Ref is the
  // underscore `attach_rtb` console id, NOT the CC composite). Route-table FIRST.
  it('EC2 TransitGatewayRouteTablePropagation: builds rtb|attach from two declared props', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::EC2::TransitGatewayRouteTablePropagation',
        physicalId: 'tgw-attach-aaa_tgw-rtb-bbb',
        declared: {
          TransitGatewayRouteTableId: 'tgw-rtb-bbb',
          TransitGatewayAttachmentId: 'tgw-attach-aaa',
        },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('tgw-rtb-bbb|tgw-attach-aaa');
  });

  it('EC2 TransitGatewayRouteTablePropagation: an unresolved segment falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::EC2::TransitGatewayRouteTablePropagation',
        physicalId: 'tgw-attach-aaa_tgw-rtb-bbb',
        declared: { TransitGatewayRouteTableId: 'tgw-rtb-bbb' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('tgw-attach-aaa_tgw-rtb-bbb');
  });

  // VPCCidrBlock: composite [Id, VpcId] — CHILD (vpc-cidr-assoc-... Id) first, then the
  // VpcId from the declared Ref (the CFn physical id is only the child Id). (#647)
  it('EC2 VPCCidrBlock: builds the Id|VpcId composite — CHILD first', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::EC2::VPCCidrBlock',
        physicalId: 'vpc-cidr-assoc-0fb680f722ffd3d6b',
        declared: { VpcId: 'vpc-099304131d588ddc1', AmazonProvidedIpv6CidrBlock: true },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('vpc-cidr-assoc-0fb680f722ffd3d6b|vpc-099304131d588ddc1');
  });

  it('EC2 VPCCidrBlock: an unresolved VpcId falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::EC2::VPCCidrBlock',
        physicalId: 'vpc-cidr-assoc-0fb680f722ffd3d6b',
        declared: {},
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('vpc-cidr-assoc-0fb680f722ffd3d6b');
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

  it('AppConfig HostedConfigurationVersion: builds the ApplicationId|ConfigurationProfileId|VersionNumber 3-seg composite', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AppConfig::HostedConfigurationVersion',
        physicalId: '1',
        declared: { ApplicationId: 'app99', ConfigurationProfileId: 'prof7' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('app99|prof7|1');
  });

  it('AppConfig Deployment: builds the ApplicationId|EnvironmentId|DeploymentNumber 3-seg composite', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::AppConfig::Deployment',
        physicalId: '1',
        declared: { ApplicationId: 'app99', EnvironmentId: 'env5' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('app99|env5|1');
  });

  it('AppConfig 3-seg composites: an unresolved parent falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    for (const t of ['AWS::AppConfig::HostedConfigurationVersion', 'AWS::AppConfig::Deployment']) {
      cc.reset();
      cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
      await readLive(
        cc as unknown as CloudControlClient,
        res({ resourceType: t, physicalId: '1', declared: { ApplicationId: 'app99' } }),
        'us-east-1',
        '1'
      );
      expect(sent()).toBe('1');
    }
  });

  // #665: ApiGatewayV2 RouteResponse is a 3-SEGMENT composite [ApiId, RouteId,
  // RouteResponseId] — parent-first, the CFn physical id is only the child
  // RouteResponseId. Both parents come from the declared Refs (ApiId → Api,
  // RouteId → Route).
  it('ApiGatewayV2 RouteResponse: builds the ApiId|RouteId|RouteResponseId 3-seg composite', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::RouteResponse',
        physicalId: 'pzrk3r',
        declared: { ApiId: 'hlc1jtf6ml', RouteId: 'r7d6lvr' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('hlc1jtf6ml|r7d6lvr|pzrk3r');
  });

  it('ApiGatewayV2 RouteResponse: an already-composite physical id is not double-prefixed', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::RouteResponse',
        physicalId: 'hlc1jtf6ml|r7d6lvr|pzrk3r',
        declared: { ApiId: 'hlc1jtf6ml', RouteId: 'r7d6lvr' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('hlc1jtf6ml|r7d6lvr|pzrk3r');
  });

  it('ApiGatewayV2 RouteResponse: an unresolved parent (missing RouteId) falls back to the raw physical id', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApiGatewayV2::RouteResponse',
        physicalId: 'pzrk3r',
        declared: { ApiId: 'hlc1jtf6ml' },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe('pzrk3r');
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

  // #836: the "flat" form declares ScalableDimension directly (with ResourceId /
  // ServiceNamespace), NO ScalingTargetId — the dimension comes off the declared
  // ScalableDimension so the policy still reads instead of read-gapping.
  it('ScalingPolicy: composes PolicyARN|ScalableDimension from the flat ScalableDimension (no ScalingTargetId, #836)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    const policyArn =
      'arn:aws:autoscaling:us-east-1:1:scalingPolicy:abc:resource/dynamodb/table/T:policyName/p';
    await readLive(
      cc as unknown as CloudControlClient,
      res({
        resourceType: 'AWS::ApplicationAutoScaling::ScalingPolicy',
        physicalId: policyArn,
        declared: {
          ResourceId: 'table/T',
          ScalableDimension: 'dynamodb:table:ReadCapacityUnits',
          ServiceNamespace: 'dynamodb',
        },
      }),
      'us-east-1',
      '1'
    );
    expect(sent()).toBe(`${policyArn}|dynamodb:table:ReadCapacityUnits`);
  });

  it('ScalingPolicy: neither ScalingTargetId nor a flat ScalableDimension falls back to the raw physical id', async () => {
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

describe('readLive (SDK supplement path — SSM::Parameter Description)', () => {
  const param = (declared: Record<string, unknown> = {}): DesiredResource =>
    res({ resourceType: 'AWS::SSM::Parameter', physicalId: '/app/db/host', declared });

  it('merges the writeOnly Description from DescribeParameters onto the CC model', async () => {
    // Cloud Control never echoes Description (writeOnly) — only Type/Value/DataType/Name.
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: '{"Type":"String","Value":"v","DataType":"text","Name":"/app/db/host"}',
      },
    });
    ssm.on(DescribeParametersCommand).resolves({ Parameters: [{ Description: 'live desc' }] });
    const r = await readLive(cc as unknown as CloudControlClient, param(), 'us-east-1', '1');
    expect(r.live).toEqual({
      Type: 'String',
      Value: 'v',
      DataType: 'text',
      Name: '/app/db/host',
      Description: 'live desc',
    });
  });

  it('also merges AllowedPattern when set, and skips it when absent', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"Type":"String","Value":"v"}' },
    });
    ssm
      .on(DescribeParametersCommand)
      .resolves({ Parameters: [{ Description: 'd', AllowedPattern: '^\\d+$' }] });
    const r = await readLive(cc as unknown as CloudControlClient, param(), 'us-east-1', '1');
    expect(r.live).toEqual({
      Type: 'String',
      Value: 'v',
      Description: 'd',
      AllowedPattern: '^\\d+$',
    });
  });

  it('merges Tier from DescribeParameters (always present; AWS auto-assigns it)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"Type":"String","Value":"v"}' },
    });
    ssm.on(DescribeParametersCommand).resolves({ Parameters: [{ Tier: 'Advanced' }] });
    const r = await readLive(cc as unknown as CloudControlClient, param(), 'us-east-1', '1');
    expect(r.live).toEqual({ Type: 'String', Value: 'v', Tier: 'Advanced' });
  });

  it('queries DescribeParameters by the declared Name (preferred over physicalId)', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    ssm.on(DescribeParametersCommand).resolves({ Parameters: [{ Description: 'd' }] });
    await readLive(
      cc as unknown as CloudControlClient,
      param({ Name: '/declared/name' }),
      'us-east-1',
      '1'
    );
    const input = ssm.commandCalls(DescribeParametersCommand)[0]?.args[0].input;
    expect(input?.ParameterFilters).toEqual([
      { Key: 'Name', Option: 'Equals', Values: ['/declared/name'] },
    ]);
  });

  it('omits Description (no FP) when AWS returns no description for the parameter', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"Type":"String","Value":"v"}' },
    });
    ssm.on(DescribeParametersCommand).resolves({ Parameters: [{}] });
    const r = await readLive(cc as unknown as CloudControlClient, param(), 'us-east-1', '1');
    expect(r.live).toEqual({ Type: 'String', Value: 'v' });
    expect('Description' in (r.live ?? {})).toBe(false);
  });

  it('keeps the CC model when the supplement read throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"Type":"String","Value":"v"}' },
    });
    ssm.on(DescribeParametersCommand).rejects(named('AccessDeniedException'));
    const r = await readLive(cc as unknown as CloudControlClient, param(), 'us-east-1', '1');
    expect(r.live).toEqual({ Type: 'String', Value: 'v' });
    expect(r.skippedReason).toBeUndefined();
  });

  it('does not run a supplement for unrelated CC types', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"BillingMode":"PAY_PER_REQUEST"}' },
    });
    await readLive(cc as unknown as CloudControlClient, res(), 'us-east-1', '1');
    expect(ssm.commandCalls(DescribeParametersCommand)).toHaveLength(0);
  });
});

describe('readLive (SDK supplement path — ElastiCache ReplicationGroup writeOnly props)', () => {
  const rg = (): DesiredResource =>
    res({ resourceType: 'AWS::ElastiCache::ReplicationGroup', physicalId: 'my-rg', declared: {} });

  it('merges the writeOnly props read verbatim from the member cache cluster', async () => {
    // CC echoes the RG body but NOT the writeOnly window / topic / version.
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: '{"ReplicationGroupId":"my-rg","CacheNodeType":"cache.t3.micro"}',
      },
    });
    elasticache
      .on(DescribeReplicationGroupsCommand)
      .resolves({ ReplicationGroups: [{ MemberClusters: ['my-rg-001'] }] });
    elasticache.on(DescribeCacheClustersCommand).resolves({
      CacheClusters: [
        {
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          NotificationConfiguration: {
            TopicArn: 'arn:aws:sns:us-east-1:1:t',
            TopicStatus: 'active',
          },
          EngineVersion: '7.1.0',
        },
      ],
    });
    const r = await readLive(cc as unknown as CloudControlClient, rg(), 'us-east-1', '1');
    expect(r.live).toEqual({
      ReplicationGroupId: 'my-rg',
      CacheNodeType: 'cache.t3.micro',
      PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      NotificationTopicArn: 'arn:aws:sns:us-east-1:1:t',
      EngineVersion: '7.1.0',
    });
    // member cluster is read by the id from DescribeReplicationGroups
    expect(
      elasticache.commandCalls(DescribeCacheClustersCommand)[0]?.args[0].input.CacheClusterId
    ).toBe('my-rg-001');
  });

  it('omits NotificationTopicArn (no FP) when no topic is configured', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"ReplicationGroupId":"my-rg"}' },
    });
    elasticache
      .on(DescribeReplicationGroupsCommand)
      .resolves({ ReplicationGroups: [{ MemberClusters: ['my-rg-001'] }] });
    elasticache.on(DescribeCacheClustersCommand).resolves({
      CacheClusters: [
        { PreferredMaintenanceWindow: 'sun:05:00-sun:06:00', EngineVersion: '7.1.0' },
      ],
    });
    const r = await readLive(cc as unknown as CloudControlClient, rg(), 'us-east-1', '1');
    expect('NotificationTopicArn' in (r.live ?? {})).toBe(false);
    expect(r.live?.PreferredMaintenanceWindow).toBe('sun:05:00-sun:06:00');
  });

  it('keeps the CC model when the supplement read throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"ReplicationGroupId":"my-rg"}' },
    });
    elasticache.on(DescribeReplicationGroupsCommand).rejects(named('AccessDeniedException'));
    const r = await readLive(cc as unknown as CloudControlClient, rg(), 'us-east-1', '1');
    expect(r.live).toEqual({ ReplicationGroupId: 'my-rg' });
    expect(r.skippedReason).toBeUndefined();
  });
});

describe('readLive (SDK supplement path — ECS Service ServiceConnectConfiguration)', () => {
  const svc = (): DesiredResource =>
    res({
      resourceType: 'AWS::ECS::Service',
      physicalId: 'arn:aws:ecs:us-east-1:1:service/c/s',
      declared: { Cluster: 'my-cluster' },
    });

  it('reconstructs the PascalCase config from the PRIMARY deployment and folds DiscoveryName==PortName', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"ServiceName":"s","Cluster":"my-cluster"}' },
    });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          deployments: [
            // An OLD deployment must be ignored — only PRIMARY is read.
            { status: 'ACTIVE', serviceConnectConfiguration: { enabled: false } },
            {
              status: 'PRIMARY',
              serviceConnectConfiguration: {
                enabled: true,
                namespace: 'arn:aws:servicediscovery:us-east-1:1:namespace/ns-x',
                services: [
                  {
                    portName: 'api',
                    discoveryName: 'api', // == portName -> dropped as the implicit default
                    clientAliases: [{ port: 8080, dnsName: 'api' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const r = await readLive(cc as unknown as CloudControlClient, svc(), 'us-east-1', '1');
    expect(r.live).toEqual({
      ServiceName: 's',
      Cluster: 'my-cluster',
      ServiceConnectConfiguration: {
        Enabled: true,
        Namespace: 'arn:aws:servicediscovery:us-east-1:1:namespace/ns-x',
        Services: [{ PortName: 'api', ClientAliases: [{ Port: 8080, DnsName: 'api' }] }],
      },
    });
    // DescribeServices is scoped by the declared cluster + the service ARN.
    const input = ecs.commandCalls(DescribeServicesCommand)[0]?.args[0].input;
    expect(input?.cluster).toBe('my-cluster');
    expect(input?.services).toEqual(['arn:aws:ecs:us-east-1:1:service/c/s']);
  });

  it('keeps an explicit non-default DiscoveryName', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          deployments: [
            {
              status: 'PRIMARY',
              serviceConnectConfiguration: {
                enabled: true,
                namespace: 'ns',
                services: [{ portName: 'api', discoveryName: 'svc-api', clientAliases: [] }],
              },
            },
          ],
        },
      ],
    });
    const r = await readLive(cc as unknown as CloudControlClient, svc(), 'us-east-1', '1');
    const config = r.live?.ServiceConnectConfiguration as Record<string, unknown>;
    expect((config.Services as Record<string, unknown>[])[0]?.DiscoveryName).toBe('svc-api');
  });

  it('adds nothing when the service has no Service Connect config (FP-safe)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"ServiceName":"s"}' },
    });
    ecs.on(DescribeServicesCommand).resolves({
      services: [{ deployments: [{ status: 'PRIMARY' }] }],
    });
    const r = await readLive(cc as unknown as CloudControlClient, svc(), 'us-east-1', '1');
    expect(r.live).toEqual({ ServiceName: 's' });
  });

  it('keeps the CC model when DescribeServices throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"ServiceName":"s"}' },
    });
    ecs.on(DescribeServicesCommand).rejects(named('AccessDeniedException'));
    const r = await readLive(cc as unknown as CloudControlClient, svc(), 'us-east-1', '1');
    expect(r.live).toEqual({ ServiceName: 's' });
    expect(r.skippedReason).toBeUndefined();
  });

  it('also reconstructs VolumeConfigurations and drops the AWS-defaulted FilesystemType "xfs"', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"ServiceName":"s"}' },
    });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          deployments: [
            {
              status: 'PRIMARY',
              volumeConfigurations: [
                {
                  name: 'vol',
                  managedEBSVolume: {
                    volumeType: 'gp3',
                    sizeInGiB: 10,
                    roleArn: 'arn:aws:iam::1:role/r',
                    filesystemType: 'xfs', // AWS default -> dropped
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const r = await readLive(cc as unknown as CloudControlClient, svc(), 'us-east-1', '1');
    expect(r.live).toEqual({
      ServiceName: 's',
      VolumeConfigurations: [
        {
          Name: 'vol',
          ManagedEBSVolume: { VolumeType: 'gp3', SizeInGiB: 10, RoleArn: 'arn:aws:iam::1:role/r' },
        },
      ],
    });
  });

  it('keeps a non-default FilesystemType', async () => {
    cc.on(GetResourceCommand).resolves({ ResourceDescription: { Properties: '{}' } });
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          deployments: [
            {
              status: 'PRIMARY',
              volumeConfigurations: [
                { name: 'vol', managedEBSVolume: { roleArn: 'r', filesystemType: 'ext4' } },
              ],
            },
          ],
        },
      ],
    });
    const r = await readLive(cc as unknown as CloudControlClient, svc(), 'us-east-1', '1');
    const vols = (r.live?.VolumeConfigurations as Record<string, unknown>[])[0];
    expect((vols?.ManagedEBSVolume as Record<string, unknown>).FilesystemType).toBe('ext4');
  });
});

describe('readLive (supplement failure re-folds exempted props to a readGap, #752)', () => {
  // When a supplement read fails (missing narrow IAM permission / throttle), a DECLARED
  // exempted prop (OVERRIDE_READABLE_WRITEONLY) must NOT false-flag as declared drift
  // against an absent live value — it must degrade to a readGap (declared value mirrored
  // into live so it folds to no drift) plus a LOUD stderr warning naming the failed call.
  let warnings: string[] = [];
  beforeEach(() => {
    warnings = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const ecUser = (declared: Record<string, unknown>): DesiredResource =>
    res({ resourceType: 'AWS::ElastiCache::User', physicalId: 'reader', declared });

  it('mirrors the DECLARED exempted prop into live (declared==live -> no drift, a readGap)', async () => {
    // CC never echoes AccessString (writeOnly); the user DECLARED it. When
    // elasticache:DescribeUsers is denied, without the fix AccessString stays absent from
    // live and false-flags declared drift; with the fix it is mirrored from declared.
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: '{"UserId":"reader","UserName":"reader","Engine":"redis","Status":"active"}',
      },
    });
    elasticache.on(DescribeCacheUsersCommand).rejects(named('AccessDeniedException'));
    const r = await readLive(
      cc as unknown as CloudControlClient,
      ecUser({
        UserId: 'reader',
        UserName: 'reader',
        Engine: 'redis',
        AccessString: 'on ~app:* -@all +@read',
      }),
      'us-east-1',
      '1'
    );
    // The declared AccessString is mirrored onto live so declared == live -> readGap, NOT
    // a `desired="…" actual=undefined` declared-tier drift.
    expect(r.live?.AccessString).toBe('on ~app:* -@all +@read');
    expect(r.skippedReason).toBeUndefined();
  });

  it('emits a LOUD stderr warning naming the failed supplement call and the read-gap prop', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"UserId":"reader","Status":"active"}' },
    });
    elasticache.on(DescribeCacheUsersCommand).rejects(named('ThrottlingException'));
    await readLive(
      cc as unknown as CloudControlClient,
      ecUser({ UserId: 'reader', AccessString: 'on ~* +@all' }),
      'us-east-1',
      '1'
    );
    const joined = warnings.join('');
    expect(joined).toContain('AWS::ElastiCache::User');
    expect(joined).toContain('ThrottlingException');
    expect(joined).toContain('AccessString');
  });

  it('does NOT mirror an UNDECLARED exempted prop (nothing to compare -> stays absent)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"UserId":"reader","Status":"active"}' },
    });
    elasticache.on(DescribeCacheUsersCommand).rejects(named('AccessDeniedException'));
    const r = await readLive(
      cc as unknown as CloudControlClient,
      ecUser({ UserId: 'reader' }), // AccessString NOT declared
      'us-east-1',
      '1'
    );
    expect('AccessString' in (r.live ?? {})).toBe(false);
    // still warns (loud), but reports no restored read-gap prop
    expect(warnings.join('')).toContain('AWS::ElastiCache::User');
  });
});

describe('readLive (SDK supplement path — cache user AccessString, #482)', () => {
  const ecUser = (): DesiredResource =>
    res({
      resourceType: 'AWS::ElastiCache::User',
      physicalId: 'reader',
      declared: { UserId: 'reader', UserName: 'reader', Engine: 'redis' },
    });
  const mdbUser = (): DesiredResource =>
    res({
      resourceType: 'AWS::MemoryDB::User',
      physicalId: 'mdb-reader',
      declared: { UserName: 'mdb-reader' },
    });

  it('merges the writeOnly AccessString from elasticache DescribeUsers onto the CC model', async () => {
    // Cloud Control never echoes AccessString (writeOnly in the registry schema) — the
    // exact live shape observed on CdkRealDriftIntegCacheUsers (#482).
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: '{"UserId":"reader","UserName":"reader","Engine":"redis","Status":"active"}',
      },
    });
    elasticache.on(DescribeCacheUsersCommand).resolves({
      Users: [{ UserId: 'reader', AccessString: 'on ~app:* -@all +@read' }],
    });
    const r = await readLive(cc as unknown as CloudControlClient, ecUser(), 'us-east-1', '1');
    expect(r.live?.AccessString).toBe('on ~app:* -@all +@read');
    expect(elasticache.commandCalls(DescribeCacheUsersCommand)[0]?.args[0].input).toEqual({
      UserId: 'reader',
    });
  });

  it('merges the writeOnly AccessString from memorydb DescribeUsers onto the CC model', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: '{"UserName":"mdb-reader","Status":"active"}',
      },
    });
    memorydb.on(DescribeMemoryDbUsersCommand).resolves({
      Users: [{ Name: 'mdb-reader', AccessString: 'on ~* &* -@all +@read' }],
    });
    const r = await readLive(cc as unknown as CloudControlClient, mdbUser(), 'us-east-1', '1');
    expect(r.live?.AccessString).toBe('on ~* &* -@all +@read');
    expect(memorydb.commandCalls(DescribeMemoryDbUsersCommand)[0]?.args[0].input).toEqual({
      UserName: 'mdb-reader',
    });
  });

  it('keeps the CC model when the user is not found / the read throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"UserId":"reader","Status":"active"}' },
    });
    elasticache.on(DescribeCacheUsersCommand).rejects(named('UserNotFoundFault'));
    const r = await readLive(cc as unknown as CloudControlClient, ecUser(), 'us-east-1', '1');
    expect(r.live).toEqual({ UserId: 'reader', Status: 'active' });
  });
});

describe('readLive (SDK supplement path — RedshiftServerless Workgroup writeOnly props, #490)', () => {
  const workgroup = (): DesiredResource =>
    res({
      resourceType: 'AWS::RedshiftServerless::Workgroup',
      physicalId: 'cdkrd-wg',
      declared: { WorkgroupName: 'cdkrd-wg' },
    });

  it('merges GetWorkgroup ConfigParameters/SecurityGroupIds/SubnetIds (camelCase -> PascalCase)', async () => {
    // The Cloud Control read returns these only inside the read-only Workgroup echo, not at the
    // top level (#490 live finding) — so an out-of-band change was a silent FN. GetWorkgroup
    // supplies them; project camelCase SDK -> PascalCase CFn so they compare against the template.
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: '{"WorkgroupName":"cdkrd-wg","BaseCapacity":8}',
      },
    });
    redshiftServerless.on(GetWorkgroupCommand).resolves({
      workgroup: {
        configParameters: [
          { parameterKey: 'enable_case_sensitive_identifier', parameterValue: 'true' },
          { parameterKey: 'require_ssl', parameterValue: 'false' },
        ],
        securityGroupIds: ['sg-0a1b2c3d4e'],
        subnetIds: ['subnet-1122334455', 'subnet-6677889900'],
      },
    });
    const r = await readLive(cc as unknown as CloudControlClient, workgroup(), 'us-east-1', '1');
    expect(r.live?.ConfigParameters).toEqual([
      { ParameterKey: 'enable_case_sensitive_identifier', ParameterValue: 'true' },
      { ParameterKey: 'require_ssl', ParameterValue: 'false' },
    ]);
    expect(r.live?.SecurityGroupIds).toEqual(['sg-0a1b2c3d4e']);
    expect(r.live?.SubnetIds).toEqual(['subnet-1122334455', 'subnet-6677889900']);
    expect(redshiftServerless.commandCalls(GetWorkgroupCommand)[0]?.args[0].input).toEqual({
      workgroupName: 'cdkrd-wg',
    });
  });

  it('keeps the CC model when GetWorkgroup throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: '{"WorkgroupName":"cdkrd-wg","BaseCapacity":8}' },
    });
    redshiftServerless.on(GetWorkgroupCommand).rejects(named('ResourceNotFoundException'));
    const r = await readLive(cc as unknown as CloudControlClient, workgroup(), 'us-east-1', '1');
    expect(r.live).toEqual({ WorkgroupName: 'cdkrd-wg', BaseCapacity: 8 });
  });
});

describe('readLive (SDK supplement path — MSK Configuration ServerProperties, #508)', () => {
  const arn = 'arn:aws:kafka:us-east-1:111111111111:configuration/cdkrd-msk-config/abc-1';
  const cfg = (): DesiredResource =>
    res({ resourceType: 'AWS::MSK::Configuration', physicalId: arn, declared: { Name: 'c' } });

  it('merges the latest revision decoded ServerProperties onto the CC model', async () => {
    // ServerProperties is writeOnly, so the CC read never echoes it (#508 silent FN);
    // DescribeConfiguration gives the latest revision and DescribeConfigurationRevision the
    // decoded blob (the JS SDK returns a Uint8Array).
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: `{"Arn":"${arn}","Name":"c"}` },
    });
    kafka
      .on(DescribeConfigurationCommand)
      .resolves({ LatestRevision: { Revision: 2, CreationTime: new Date(0) } });
    kafka.on(DescribeConfigurationRevisionCommand).resolves({
      ServerProperties: new TextEncoder().encode('auto.create.topics.enable=true\n'),
    });
    const r = await readLive(cc as unknown as CloudControlClient, cfg(), 'us-east-1', '1');
    expect(r.live?.ServerProperties).toBe('auto.create.topics.enable=true\n');
    expect(kafka.commandCalls(DescribeConfigurationRevisionCommand)[0]?.args[0].input).toEqual({
      Arn: arn,
      Revision: 2,
    });
  });

  it('keeps the CC model when a kafka read throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: `{"Arn":"${arn}","Name":"c"}` },
    });
    kafka.on(DescribeConfigurationCommand).rejects(named('NotFoundException'));
    const r = await readLive(cc as unknown as CloudControlClient, cfg(), 'us-east-1', '1');
    expect(r.live).toEqual({ Arn: arn, Name: 'c' });
  });
});

describe('readLive (SDK supplement path — ELBv2 TrustStore CA bundle content hash, #505)', () => {
  const arn = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:truststore/cdkrd-ts/abc';
  const ts = (): DesiredResource =>
    res({
      resourceType: 'AWS::ElasticLoadBalancingV2::TrustStore',
      physicalId: arn,
      declared: { Name: 'cdkrd-ts' },
    });
  const bundle = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('projects CaCertificatesBundleSha256 from the fetched presigned bundle', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: `{"TrustStoreArn":"${arn}","Name":"cdkrd-ts"}` },
    });
    elbv2
      .on(GetTrustStoreCaCertificatesBundleCommand)
      .resolves({ Location: 'https://s3.example.com/presigned' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(bundle) })
    );
    const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');
    expect(r.live?.CaCertificatesBundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(elbv2.commandCalls(GetTrustStoreCaCertificatesBundleCommand)[0]?.args[0].input).toEqual({
      TrustStoreArn: arn,
    });
  });

  it('keeps the CC model when GetTrustStoreCaCertificatesBundle throws (non-fatal)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: `{"TrustStoreArn":"${arn}","Name":"cdkrd-ts"}` },
    });
    elbv2.on(GetTrustStoreCaCertificatesBundleCommand).rejects(named('AccessDeniedException'));
    const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');
    expect(r.live).toEqual({ TrustStoreArn: arn, Name: 'cdkrd-ts' });
  });

  it('keeps the CC model when the presigned fetch fails (non-fatal, no bogus hash)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: `{"TrustStoreArn":"${arn}","Name":"cdkrd-ts"}` },
    });
    elbv2
      .on(GetTrustStoreCaCertificatesBundleCommand)
      .resolves({ Location: 'https://s3.example.com/presigned' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('Access Denied') })
    );
    const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');
    expect(r.live).toEqual({ TrustStoreArn: arn, Name: 'cdkrd-ts' });
  });
});

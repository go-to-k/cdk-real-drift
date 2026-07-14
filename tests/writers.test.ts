import {
  APIGatewayClient,
  UpdateIntegrationCommand,
  UpdateIntegrationResponseCommand,
  UpdateMethodResponseCommand,
  UpdateRestApiCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  DeleteAccessLogSettingsCommand,
  DeleteRouteSettingsCommand,
  UpdateStageCommand as UpdateApiGatewayV2StageCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  CloudWatchClient,
  DescribeAnomalyDetectorsCommand,
  DisableAlarmActionsCommand,
  EnableAlarmActionsCommand,
  PutAnomalyDetectorCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  DLMClient,
  GetLifecyclePolicyCommand,
  UpdateLifecyclePolicyCommand,
} from '@aws-sdk/client-dlm';
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  DescribeDomainConfigCommand,
  OpenSearchClient,
  UpdateDomainConfigCommand,
} from '@aws-sdk/client-opensearch';
import { GetWebACLCommand, UpdateWebACLCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import {
  DescribeReceiptRuleCommand,
  SESClient,
  UpdateReceiptRuleCommand,
} from '@aws-sdk/client-ses';
import {
  ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreatePolicyVersionCommand,
  DetachGroupPolicyCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  DeletePolicyVersionCommand,
  DeleteRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListPolicyVersionsCommand,
  PutGroupPolicyCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DocDBClient,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-docdb';
import {
  ElasticBeanstalkClient,
  UpdateApplicationCommand,
  UpdateApplicationResourceLifecycleCommand,
  UpdateEnvironmentCommand,
} from '@aws-sdk/client-elastic-beanstalk';
import {
  GetClassifierCommand,
  GetConnectionCommand,
  GetJobCommand,
  GetTableCommand,
  GetWorkflowCommand,
  GlueClient,
  UpdateClassifierCommand,
  UpdateConnectionCommand,
  UpdateJobCommand,
  UpdateTableCommand,
  UpdateWorkflowCommand,
} from '@aws-sdk/client-glue';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
  PutBearerTokenAuthenticationCommand,
  PutMetricFilterCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  GetTopicAttributesCommand,
  SetTopicAttributesCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import {
  GetNamespaceCommand,
  GetServiceCommand,
  ServiceDiscoveryClient,
  UpdateHttpNamespaceCommand,
  UpdateServiceCommand as SdUpdateServiceCommand,
} from '@aws-sdk/client-servicediscovery';
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import {
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ConfigServiceClient,
  DescribeConfigRulesCommand,
  PutConfigRuleCommand,
} from '@aws-sdk/client-config-service';
import {
  DescribeEventBusCommand,
  EventBridgeClient,
  PutPermissionCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CloudControlClient,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { KafkaClient, UpdateConfigurationCommand } from '@aws-sdk/client-kafka';
import {
  BatchGetProjectsCommand,
  BatchGetReportGroupsCommand,
  CodeBuildClient,
  UpdateProjectCommand,
  UpdateReportGroupCommand,
} from '@aws-sdk/client-codebuild';
import {
  GetQueueCommand,
  MediaConvertClient,
  UpdateQueueCommand,
} from '@aws-sdk/client-mediaconvert';
import {
  DAXClient,
  DescribeClustersCommand,
  DescribeParameterGroupsCommand,
  DescribeParametersCommand as DescribeDaxParametersCommand,
  UpdateClusterCommand,
  UpdateParameterGroupCommand as UpdateDaxParameterGroupCommand,
} from '@aws-sdk/client-dax';
import {
  DescribeCacheParameterGroupsCommand,
  DescribeCacheParametersCommand,
  ElastiCacheClient,
  ModifyCacheParameterGroupCommand,
  ResetCacheParameterGroupCommand,
} from '@aws-sdk/client-elasticache';
import {
  MemoryDBClient,
  ResetParameterGroupCommand as ResetMemoryDbParameterGroupCommand,
  UpdateParameterGroupCommand as UpdateMemoryDbParameterGroupCommand,
} from '@aws-sdk/client-memorydb';
import {
  DescribeClientVpnEndpointsCommand,
  EC2Client,
  ModifyClientVpnEndpointCommand,
} from '@aws-sdk/client-ec2';
import {
  BuildBotLocaleCommand,
  CreateIntentCommand,
  CreateSlotCommand,
  CreateSlotTypeCommand,
  DeleteIntentCommand,
  DeleteSlotCommand,
  DeleteSlotTypeCommand,
  DescribeBotLocaleCommand,
  DescribeIntentCommand,
  DescribeSlotCommand,
  DescribeSlotTypeCommand,
  LexModelsV2Client,
  ListIntentsCommand,
  ListSlotsCommand,
  ListSlotTypesCommand,
  UpdateBotLocaleCommand,
  UpdateIntentCommand,
  UpdateSlotCommand,
  UpdateSlotTypeCommand,
} from '@aws-sdk/client-lex-models-v2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import type { PatchOp } from '../src/revert/plan.js';
import {
  pollNestedToCompletion,
  resolveSdkWriter,
  SDK_NESTED_WRITERS,
  SDK_WRITERS,
} from '../src/revert/writers.js';

const iam = mockClient(IAMClient);
const elb = mockClient(ElasticLoadBalancingV2Client);
const sns = mockClient(SNSClient);
const sqs = mockClient(SQSClient);
const serviceDiscovery = mockClient(ServiceDiscoveryClient);
const docdb = mockClient(DocDBClient);
const eb = mockClient(ElasticBeanstalkClient);
const cloudfront = mockClient(CloudFrontClient);
const wafv2 = mockClient(WAFV2Client);
const opensearch = mockClient(OpenSearchClient);
const glue = mockClient(GlueClient);
const ses = mockClient(SESClient);
const logs = mockClient(CloudWatchLogsClient);
const route53 = mockClient(Route53Client);
const configService = mockClient(ConfigServiceClient);
const eventbridge = mockClient(EventBridgeClient);
const apigw = mockClient(APIGatewayClient);
const apigwv2 = mockClient(ApiGatewayV2Client);
const ecs = mockClient(ECSClient);
const cloudwatch = mockClient(CloudWatchClient);
const dlm = mockClient(DLMClient);
const cloudcontrol = mockClient(CloudControlClient);
const kafka = mockClient(KafkaClient);
const codebuild = mockClient(CodeBuildClient);
const mediaconvert = mockClient(MediaConvertClient);
const dax = mockClient(DAXClient);
const elasticache = mockClient(ElastiCacheClient);
const memorydb = mockClient(MemoryDBClient);
const ec2 = mockClient(EC2Client);
const lex = mockClient(LexModelsV2Client);

const ARN = 'arn:aws:iam::123456789012:policy/p';
const ctx = (over: Partial<OverrideCtx> = {}): OverrideCtx => ({
  physicalId: ARN,
  declared: {},
  region: 'us-east-1',
  accountId: '123456789012',
  ...over,
});
const DESIRED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
};
const addOp = (value: unknown): PatchOp => ({
  op: 'add',
  path: '/PolicyDocument',
  value,
  human: 'PolicyDocument -> deployed-template value',
});

// the override reader for ManagedPolicy reads GetPolicy + GetPolicyVersion(default)
const stubReader = (currentDoc: unknown): void => {
  iam.on(GetPolicyCommand).resolves({ Policy: { Path: '/', DefaultVersionId: 'v1' } });
  iam
    .on(GetPolicyVersionCommand)
    .resolves({ PolicyVersion: { Document: JSON.stringify(currentDoc) } });
};

beforeEach(() => {
  iam.reset();
  elb.reset();
  sns.reset();
  sqs.reset();
  serviceDiscovery.reset();
  elasticache.reset();
  memorydb.reset();
  docdb.reset();
  eb.reset();
  cloudfront.reset();
  wafv2.reset();
  opensearch.reset();
  glue.reset();
  ses.reset();
  logs.reset();
  route53.reset();
  configService.reset();
  kafka.reset();
  eventbridge.reset();
  apigw.reset();
  apigwv2.reset();
  ecs.reset();
  cloudwatch.reset();
  dlm.reset();
  cloudcontrol.reset();
  codebuild.reset();
  mediaconvert.reset();
  dax.reset();
  ec2.reset();
  lex.reset();
});

describe('CloudWatch AnomalyDetector writer (PutAnomalyDetector upsert, issue #461)', () => {
  const liveDetector = {
    SingleMetricAnomalyDetector: {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Stat: 'Sum',
    },
    Configuration: { MetricTimezone: 'UTC' }, // drifted out of band
  };
  const cwCtx = ctx({
    physicalId: 'abc-generated-id',
    declared: {
      SingleMetricAnomalyDetector: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Stat: 'Sum' },
      Configuration: { MetricTimeZone: 'Asia/Tokyo' },
    },
  });

  it('re-supplies the createOnly identity + desired Configuration (MetricTimeZone -> MetricTimezone)', async () => {
    cloudwatch.on(DescribeAnomalyDetectorsCommand).resolves({ AnomalyDetectors: [liveDetector] });
    cloudwatch.on(PutAnomalyDetectorCommand).resolves({});
    await SDK_WRITERS['AWS::CloudWatch::AnomalyDetector'](cwCtx, [
      {
        op: 'add',
        path: '/Configuration/MetricTimeZone',
        value: 'Asia/Tokyo',
        human: 'Configuration.MetricTimeZone -> deployed-template value',
      },
    ]);
    const calls = cloudwatch.commandCalls(PutAnomalyDetectorCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as Record<string, unknown>;
    expect(input.SingleMetricAnomalyDetector).toEqual({
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Stat: 'Sum',
    });
    expect(input.Configuration).toEqual({ MetricTimezone: 'Asia/Tokyo' });
  });

  it('a REMOVE op (revert an out-of-band-added timezone) sends an empty Configuration', async () => {
    cloudwatch.on(DescribeAnomalyDetectorsCommand).resolves({ AnomalyDetectors: [liveDetector] });
    cloudwatch.on(PutAnomalyDetectorCommand).resolves({});
    await SDK_WRITERS['AWS::CloudWatch::AnomalyDetector'](
      ctx({
        physicalId: 'abc-generated-id',
        declared: {
          SingleMetricAnomalyDetector: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
          },
        },
      }),
      [
        {
          op: 'remove',
          path: '/Configuration/MetricTimeZone',
          human: 'Configuration.MetricTimeZone -> remove (undeclared)',
        },
      ]
    );
    const input = cloudwatch.commandCalls(PutAnomalyDetectorCommand)[0]!.args[0].input as Record<
      string,
      unknown
    >;
    expect(input.Configuration).toEqual({});
  });

  it('zone-less CFn range strings are parsed as UTC, not local time', async () => {
    cloudwatch.on(DescribeAnomalyDetectorsCommand).resolves({
      AnomalyDetectors: [
        {
          SingleMetricAnomalyDetector: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
          },
          Configuration: {
            MetricTimezone: 'UTC',
            ExcludedTimeRanges: [
              {
                StartTime: new Date('2026-12-24T06:00:00Z'), // drifted out of band
                EndTime: new Date('2026-12-26T00:00:00Z'),
              },
            ],
          },
        },
      ],
    });
    cloudwatch.on(PutAnomalyDetectorCommand).resolves({});
    await SDK_WRITERS['AWS::CloudWatch::AnomalyDetector'](
      ctx({
        physicalId: 'abc-generated-id',
        declared: {
          SingleMetricAnomalyDetector: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
          },
        },
      }),
      [
        {
          op: 'add',
          // the declared value is in the CFn Range pattern: zone-less, meaning UTC —
          // a bare new Date() would shift it by the machine's local offset.
          path: '/Configuration/ExcludedTimeRanges/0/StartTime',
          value: '2026-12-24T00:00:00',
          human: 'Configuration.ExcludedTimeRanges.0.StartTime -> deployed-template value',
        },
      ]
    );
    const input = cloudwatch.commandCalls(PutAnomalyDetectorCommand)[0]!.args[0].input;
    expect(input.Configuration?.ExcludedTimeRanges?.[0]?.StartTime).toEqual(
      new Date('2026-12-24T00:00:00Z')
    );
  });

  it('throws when no detector identity can be resolved', async () => {
    cloudwatch.on(DescribeAnomalyDetectorsCommand).resolves({ AnomalyDetectors: [] });
    await expect(
      SDK_WRITERS['AWS::CloudWatch::AnomalyDetector'](ctx({ physicalId: '', declared: {} }), [])
    ).rejects.toThrow(/anomaly-detector/);
  });
});

describe('DLM LifecyclePolicy writer (UpdateLifecyclePolicy, issue #468)', () => {
  // live GetLifecyclePolicy has the schedule retain count drifted (5) away from intent (14)
  const livePolicy = {
    Policy: {
      PolicyId: 'policy-0abc',
      Description: 'backups',
      State: 'ENABLED',
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
      PolicyDetails: {
        PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
        ResourceTypes: ['VOLUME'],
        TargetTags: [{ Key: 'backup', Value: 'true' }],
        Schedules: [
          {
            Name: 'daily',
            CreateRule: { Interval: 24, IntervalUnit: 'HOURS' },
            RetainRule: { Count: 5 },
          },
        ],
      },
    },
  };
  const dlmCtx = (declared: Record<string, unknown>): OverrideCtx =>
    ctx({ physicalId: 'policy-0abc', declared });

  it('reconstructs the desired PolicyDetails (custom style) and re-sends it via UpdateLifecyclePolicy', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves(livePolicy as never);
    dlm.on(UpdateLifecyclePolicyCommand).resolves({});
    await SDK_WRITERS['AWS::DLM::LifecyclePolicy'](
      dlmCtx({
        Description: 'backups',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        PolicyDetails: livePolicy.Policy.PolicyDetails,
      }),
      [
        {
          op: 'add',
          path: '/PolicyDetails/Schedules/0/RetainRule/Count',
          value: 14,
          human: 'PolicyDetails.Schedules.0.RetainRule.Count -> deployed-template value',
        },
      ]
    );
    const calls = dlm.commandCalls(UpdateLifecyclePolicyCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.PolicyId).toBe('policy-0abc');
    const details = input.PolicyDetails as { Schedules: { RetainRule: { Count: number } }[] };
    expect(details.Schedules[0]!.RetainRule.Count).toBe(14);
  });

  it('reverts a State flip (DISABLED -> ENABLED)', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: { ...livePolicy.Policy, State: 'DISABLED' },
    } as never);
    dlm.on(UpdateLifecyclePolicyCommand).resolves({});
    await SDK_WRITERS['AWS::DLM::LifecyclePolicy'](
      dlmCtx({
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        PolicyDetails: livePolicy.Policy.PolicyDetails,
      }),
      [
        {
          op: 'add',
          path: '/State',
          value: 'ENABLED',
          human: 'State -> deployed-template value',
        },
      ]
    );
    const input = dlm.commandCalls(UpdateLifecyclePolicyCommand)[0]!.args[0]
      .input as unknown as Record<string, unknown>;
    expect(input.State).toBe('ENABLED');
  });

  it('default-policy shorthand: overlays the desired shorthand key onto the live PolicyDetails', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: {
        PolicyId: 'policy-0def',
        PolicyDetails: {
          PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
          PolicyLanguage: 'SIMPLIFIED',
          ResourceType: 'VOLUME',
          CreateInterval: 24, // drifted from intent (12)
          RetainInterval: 7,
        },
      },
    } as never);
    dlm.on(UpdateLifecyclePolicyCommand).resolves({});
    await SDK_WRITERS['AWS::DLM::LifecyclePolicy'](
      ctx({
        physicalId: 'policy-0def',
        declared: { CreateInterval: 12, RetainInterval: 7 },
      }),
      [
        {
          op: 'add',
          path: '/CreateInterval',
          value: 12,
          human: 'CreateInterval -> deployed-template value',
        },
      ]
    );
    const input = dlm.commandCalls(UpdateLifecyclePolicyCommand)[0]!.args[0]
      .input as unknown as Record<string, unknown>;
    const details = input.PolicyDetails as Record<string, unknown>;
    // the immutable PolicyType/ResourceType survive from the live read; the drifted
    // shorthand key is reverted
    expect(details.PolicyType).toBe('EBS_SNAPSHOT_MANAGEMENT');
    expect(details.CreateInterval).toBe(12);
  });

  it('throws when the policy id cannot be resolved', async () => {
    await expect(
      SDK_WRITERS['AWS::DLM::LifecyclePolicy'](ctx({ physicalId: '', declared: {} }), [])
    ).rejects.toThrow(/DLM lifecycle policy/);
  });

  it('bars a top-level State remove honestly instead of silently dropping it (#913)', async () => {
    // no clearing value is safe for a top-level `remove` (Update always requires a State) — fail
    // honestly rather than omit the field and non-converge; the throw precedes any live read.
    await expect(
      SDK_WRITERS['AWS::DLM::LifecyclePolicy'](dlmCtx({}), [
        { op: 'remove', path: '/State', human: 'State -> (none)' },
      ])
    ).rejects.toThrow(/State cannot be cleared/);
    expect(dlm.commandCalls(UpdateLifecyclePolicyCommand)).toHaveLength(0);
  });
});

describe('ECS ServiceConnect writer (re-supplies the whole writeOnly config via UpdateService)', () => {
  it('camelCases the declared config and calls UpdateService with cluster + service', async () => {
    ecs.on(UpdateServiceCommand).resolves({});
    const ecsCtx = ctx({
      physicalId: 'arn:aws:ecs:us-east-1:1:service/c/s',
      declared: {
        Cluster: 'my-cluster',
        ServiceConnectConfiguration: {
          Enabled: true,
          Namespace: 'arn:aws:servicediscovery:us-east-1:1:namespace/ns-x',
          Services: [{ PortName: 'api', ClientAliases: [{ Port: 8080, DnsName: 'api' }] }],
        },
      },
    });
    // Any drift path under ServiceConnectConfiguration resolves to the nested writer.
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/ServiceConnectConfiguration/Services/0/ClientAliases/0/DnsName',
        value: 'api',
        human: '',
      },
    ];
    const writer = resolveSdkWriter('AWS::ECS::Service', ops);
    expect(writer).toBeDefined();
    await writer!(ecsCtx, ops);
    const input = ecs.commandCalls(UpdateServiceCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      cluster: 'my-cluster',
      service: 'arn:aws:ecs:us-east-1:1:service/c/s',
      serviceConnectConfiguration: {
        enabled: true,
        namespace: 'arn:aws:servicediscovery:us-east-1:1:namespace/ns-x',
        services: [{ portName: 'api', clientAliases: [{ port: 8080, dnsName: 'api' }] }],
      },
    });
  });

  it('a service with NO declared config disables Service Connect (enabled: false)', async () => {
    ecs.on(UpdateServiceCommand).resolves({});
    const ecsCtx = ctx({ physicalId: 'svc-arn', declared: { Cluster: 'c' } });
    const ops: PatchOp[] = [{ op: 'remove', path: '/ServiceConnectConfiguration', human: '' }];
    await resolveSdkWriter('AWS::ECS::Service', ops)!(ecsCtx, ops);
    expect(
      ecs.commandCalls(UpdateServiceCommand)[0]!.args[0].input.serviceConnectConfiguration
    ).toEqual({
      enabled: false,
    });
  });

  it('reverts a VolumeConfigurations drift: camelCases the declared volumes, sends ONLY that prop', async () => {
    ecs.on(UpdateServiceCommand).resolves({});
    const ecsCtx = ctx({
      physicalId: 'arn:aws:ecs:us-east-1:1:service/c/s',
      declared: {
        Cluster: 'my-cluster',
        ServiceConnectConfiguration: { Enabled: true },
        VolumeConfigurations: [
          { Name: 'vol', ManagedEBSVolume: { VolumeType: 'gp3', SizeInGiB: 20, RoleArn: 'r' } },
        ],
      },
    });
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/VolumeConfigurations/0/ManagedEBSVolume/SizeInGiB',
        value: 20,
        human: '',
      },
    ];
    await resolveSdkWriter('AWS::ECS::Service', ops)!(ecsCtx, ops);
    const input = ecs.commandCalls(UpdateServiceCommand)[0]!.args[0].input;
    expect(input.volumeConfigurations).toEqual([
      { name: 'vol', managedEBSVolume: { volumeType: 'gp3', sizeInGiB: 20, roleArn: 'r' } },
    ]);
    // ServiceConnect is NOT re-sent — the ops only touched VolumeConfigurations, and
    // UpdateService leaves untouched props alone.
    expect(input.serviceConnectConfiguration).toBeUndefined();
  });
});

describe('ApiGateway Method integration writer (nested knobs CC cannot patch)', () => {
  const apigwCtx = (): OverrideCtx => ctx({ physicalId: 'abc|9zav19|OPTIONS' });
  const rmOp = (path: string): PatchOp => ({ op: 'remove', path, human: `${path} -> remove` });

  it('reverts integration-level + per-response knobs via UpdateIntegration / UpdateIntegrationResponse', async () => {
    apigw.on(UpdateIntegrationCommand).resolves({});
    apigw.on(UpdateIntegrationResponseCommand).resolves({});
    const ops: PatchOp[] = [
      rmOp('/Integration/PassthroughBehavior'),
      rmOp('/Integration/IntegrationResponses[204]/SelectionPattern'),
      rmOp('/Integration/IntegrationResponses[204]/ContentHandling'),
    ];
    const writer = resolveSdkWriter('AWS::ApiGateway::Method', ops);
    expect(writer).toBeDefined();
    await writer!(apigwCtx(), ops);

    // PassthroughBehavior cannot be removed (no absence-default) -> replace with the default.
    const integ = apigw.commandCalls(UpdateIntegrationCommand);
    expect(integ).toHaveLength(1);
    expect(integ[0]!.args[0].input).toMatchObject({
      restApiId: 'abc',
      resourceId: '9zav19',
      httpMethod: 'OPTIONS',
      patchOperations: [{ op: 'replace', path: '/passthroughBehavior', value: 'WHEN_NO_MATCH' }],
    });
    // SelectionPattern + ContentHandling clear by replacing with "" (API Gateway rejects
    // `remove` for them), batched into ONE per-statusCode call.
    const resp = apigw.commandCalls(UpdateIntegrationResponseCommand);
    expect(resp).toHaveLength(1);
    expect(resp[0]!.args[0].input).toMatchObject({
      restApiId: 'abc',
      resourceId: '9zav19',
      httpMethod: 'OPTIONS',
      statusCode: '204',
      patchOperations: [
        { op: 'replace', path: '/selectionPattern', value: '' },
        { op: 'replace', path: '/contentHandling', value: '' },
      ],
    });
  });

  it('a declared-drift (add) op replaces with the desired value', async () => {
    apigw.on(UpdateIntegrationCommand).resolves({});
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/Integration/PassthroughBehavior',
        value: 'WHEN_NO_TEMPLATES',
        human: 'x',
      },
    ];
    await resolveSdkWriter('AWS::ApiGateway::Method', ops)!(apigwCtx(), ops);
    expect(apigw.commandCalls(UpdateIntegrationCommand)[0]!.args[0].input).toMatchObject({
      patchOperations: [
        { op: 'replace', path: '/passthroughBehavior', value: 'WHEN_NO_TEMPLATES' },
      ],
    });
  });

  it('throws on an unparseable Method physical id', async () => {
    const ops: PatchOp[] = [rmOp('/Integration/PassthroughBehavior')];
    await expect(
      resolveSdkWriter('AWS::ApiGateway::Method', ops)!(ctx({ physicalId: 'bad' }), ops)
    ).rejects.toThrow(/cannot parse ApiGateway Method id/);
  });

  it('reverts an out-of-band MethodResponses ResponseModels via UpdateMethodResponse (remove per media key)', async () => {
    apigw.on(UpdateMethodResponseCommand).resolves({});
    // classify emits the whole live-only ResponseModels map; revertOp carries it as `prior`.
    const ops: PatchOp[] = [
      {
        op: 'remove',
        path: '/MethodResponses[200]/ResponseModels',
        prior: { 'application/json': 'Error' },
        human: 'remove',
      },
    ];
    await resolveSdkWriter('AWS::ApiGateway::Method', ops)!(apigwCtx(), ops);
    const calls = apigw.commandCalls(UpdateMethodResponseCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      restApiId: 'abc',
      resourceId: '9zav19',
      httpMethod: 'OPTIONS',
      statusCode: '200',
      patchOperations: [{ op: 'remove', path: '/responseModels/application~1json' }],
    });
  });
});

describe('EventBusPolicy writer (CC RFC6902 patch fails on a singular-object Statement)', () => {
  const desiredStmt = {
    Sid: 'AllowSelfPutEvents',
    Effect: 'Allow',
    Principal: { AWS: 'arn:aws:iam::123456789012:root' },
    Action: 'events:PutEvents',
    Resource: 'arn:aws:events:us-east-1:123456789012:event-bus/mybus',
  };
  const ebpCtx = (over: Partial<OverrideCtx> = {}): OverrideCtx =>
    ctx({
      physicalId: 'mybus|AllowSelfPutEvents',
      declared: {
        EventBusName: 'mybus',
        StatementId: 'AllowSelfPutEvents',
        Statement: desiredStmt,
      },
      ...over,
    });

  it('reverts via PutPermission, restoring the declared statement by StatementId and PRESERVING a sibling', async () => {
    // live bus policy has the drifted target (Action changed to PutRule) + an unrelated sibling.
    eventbridge.on(DescribeEventBusCommand).resolves({
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { ...desiredStmt, Action: 'events:PutRule' },
          {
            Sid: 'SiblingFromAnotherResource',
            Effect: 'Allow',
            Principal: '*',
            Action: 'events:PutEvents',
          },
        ],
      }),
    });
    await SDK_WRITERS['AWS::Events::EventBusPolicy'](ebpCtx(), []);
    const calls = eventbridge.commandCalls(PutPermissionCommand);
    expect(calls).toHaveLength(1);
    const policy = JSON.parse(calls[0].args[0].input.Policy as string);
    const target = policy.Statement.find((s: { Sid: string }) => s.Sid === 'AllowSelfPutEvents');
    expect(target.Action).toBe('events:PutEvents'); // restored
    // the sibling statement is untouched (not wiped by the revert)
    expect(
      policy.Statement.some((s: { Sid: string }) => s.Sid === 'SiblingFromAnotherResource')
    ).toBe(true);
    expect(calls[0].args[0].input.EventBusName).toBe('mybus');
  });

  it('re-adds the declared statement when it was removed out of band (no Sid match in live)', async () => {
    eventbridge.on(DescribeEventBusCommand).resolves({
      Policy: JSON.stringify({ Version: '2012-10-17', Statement: [] }),
    });
    await SDK_WRITERS['AWS::Events::EventBusPolicy'](ebpCtx(), []);
    const policy = JSON.parse(
      eventbridge.commandCalls(PutPermissionCommand)[0].args[0].input.Policy as string
    );
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0].Sid).toBe('AllowSelfPutEvents');
  });

  it('throws when the StatementId is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::Events::EventBusPolicy'](
        ebpCtx({ declared: { EventBusName: 'mybus' } }),
        []
      )
    ).rejects.toThrow(/StatementId/);
  });

  it('uses the region partition for the legacy Action+Principal ARNs (GovCloud aws-us-gov, #865)', async () => {
    eventbridge.on(DescribeEventBusCommand).resolves({
      Policy: JSON.stringify({ Version: '2012-10-17', Statement: [] }),
    });
    await SDK_WRITERS['AWS::Events::EventBusPolicy'](
      ebpCtx({
        region: 'us-gov-west-1',
        declared: {
          EventBusName: 'mybus',
          StatementId: 'AllowSelfPutEvents',
          Action: 'events:PutEvents',
          Principal: '123456789012',
        },
      }),
      []
    );
    const policy = JSON.parse(
      eventbridge.commandCalls(PutPermissionCommand)[0].args[0].input.Policy as string
    );
    const stmt = policy.Statement[0];
    expect(stmt.Principal.AWS).toBe('arn:aws-us-gov:iam::123456789012:root');
    expect(stmt.Resource).toBe('arn:aws-us-gov:events:us-gov-west-1:123456789012:event-bus/mybus');
  });
});

describe('OpenSearch Domain writer (CC UpdateResource rejects on override_main_response_version)', () => {
  const volOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/EBSOptions/VolumeSize',
    value,
    human: 'EBSOptions.VolumeSize -> deployed-template value',
  });
  it('reverts via UpdateDomainConfig sending ONLY the touched option (untouched AdvancedOptions not re-submitted)', async () => {
    opensearch.on(DescribeDomainConfigCommand).resolves({
      DomainConfig: {
        EBSOptions: { Options: { EBSEnabled: true, VolumeType: 'gp3', VolumeSize: 20 } },
        // AdvancedOptions carries the AWS-managed legacy key CC re-submit chokes on —
        // it is NOT touched by the op, so the writer must not send it at all.
        AdvancedOptions: { Options: { override_main_response_version: 'false' } },
        ClusterConfig: { Options: { InstanceCount: 1 } },
      },
    } as never);
    opensearch.on(UpdateDomainConfigCommand).resolves({});
    await SDK_WRITERS['AWS::OpenSearchService::Domain'](ctx({ physicalId: 'my-domain' }), [
      volOp(10),
    ]);
    const calls = opensearch.commandCalls(UpdateDomainConfigCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.DomainName).toBe('my-domain');
    expect(input.EBSOptions).toEqual({ EBSEnabled: true, VolumeType: 'gp3', VolumeSize: 10 });
    // untouched options are NOT re-submitted (the bug trigger)
    expect('AdvancedOptions' in input).toBe(false);
    expect('ClusterConfig' in input).toBe(false);
  });

  it('drops the AWS-managed override_main_response_version when AdvancedOptions IS reverted', async () => {
    opensearch.on(DescribeDomainConfigCommand).resolves({
      DomainConfig: {
        AdvancedOptions: {
          Options: {
            'rest.action.multi.allow_explicit_index': 'true',
            override_main_response_version: 'false',
          },
        },
      },
    } as never);
    opensearch.on(UpdateDomainConfigCommand).resolves({});
    await SDK_WRITERS['AWS::OpenSearchService::Domain'](ctx({ physicalId: 'd' }), [
      {
        op: 'add',
        path: '/AdvancedOptions/rest.action.multi.allow_explicit_index',
        value: 'false',
        human: 'x',
      },
    ]);
    const ao = (
      opensearch.commandCalls(UpdateDomainConfigCommand)[0]!.args[0].input as unknown as {
        AdvancedOptions: Record<string, unknown>;
      }
    ).AdvancedOptions;
    expect('override_main_response_version' in ao).toBe(false);
    expect(ao['rest.action.multi.allow_explicit_index']).toBe('false');
  });

  it('throws when the domain name is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::OpenSearchService::Domain'](ctx({ physicalId: '', declared: {} }), [
        volOp(10),
      ])
    ).rejects.toThrow(/OpenSearch domain name/);
  });
});

describe('Glue Job writer (CC UpdateResource rejects MaxCapacity+WorkerType)', () => {
  const timeoutOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/Timeout',
    value,
    human: 'Timeout -> deployed-template value',
  });
  it('reverts via GetJob -> UpdateJob, OMITTING MaxCapacity/AllocatedCapacity for a WorkerType job', async () => {
    // AWS returns a computed MaxCapacity for a WorkerType job; re-sending both via CC
    // UpdateResource fails "do not set Max Capacity if using Worker Type". The writer
    // drops MaxCapacity/AllocatedCapacity when WorkerType is set.
    glue.on(GetJobCommand).resolves({
      Job: {
        Name: 'j',
        Role: 'arn:aws:iam::111111111111:role/r',
        Command: { Name: 'glueetl', ScriptLocation: 's3://b/s.py' },
        Timeout: 20,
        WorkerType: 'G.1X',
        NumberOfWorkers: 2,
        GlueVersion: '4.0',
        MaxCapacity: 0.0625, // AWS-computed, must be dropped
        AllocatedCapacity: 2, // deprecated alias, dropped
        CreatedOn: new Date(0), // read-only, not in JobUpdate
      },
    } as never);
    glue.on(UpdateJobCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Job'](ctx({ physicalId: 'j' }), [timeoutOp(10)]);
    const calls = glue.commandCalls(UpdateJobCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as {
      JobName: string;
      JobUpdate: Record<string, unknown>;
    };
    expect(input.JobName).toBe('j');
    expect(input.JobUpdate.Timeout).toBe(10); // reverted scalar
    expect(input.JobUpdate.WorkerType).toBe('G.1X'); // round-tripped
    expect('MaxCapacity' in input.JobUpdate).toBe(false); // dropped (the bug trigger)
    expect('AllocatedCapacity' in input.JobUpdate).toBe(false);
    expect('CreatedOn' in input.JobUpdate).toBe(false); // read-only excluded
  });

  it('KEEPS MaxCapacity for a non-WorkerType job', async () => {
    glue.on(GetJobCommand).resolves({
      Job: {
        Name: 'j',
        Role: 'arn:aws:iam::111111111111:role/r',
        Command: { Name: 'glueetl' },
        Timeout: 20,
        MaxCapacity: 10,
      },
    } as never);
    glue.on(UpdateJobCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Job'](ctx({ physicalId: 'j' }), [timeoutOp(10)]);
    const input = glue.commandCalls(UpdateJobCommand)[0]!.args[0].input as unknown as {
      JobUpdate: Record<string, unknown>;
    };
    expect(input.JobUpdate.MaxCapacity).toBe(10);
  });

  it('#1568: sends only ONE capacity form for a non-WorkerType job — GetJob echoes BOTH', async () => {
    // A real GetJob returns BOTH MaxCapacity and its deprecated duplicate
    // AllocatedCapacity (live-proven on a barest glueetl job), and UpdateJob rejects a
    // JobUpdate carrying both ("Please set only Allocated Capacity or Max Capacity."),
    // which made EVERY revert on a non-WorkerType job fail. The writer must keep
    // MaxCapacity and drop the AllocatedCapacity duplicate.
    glue.on(GetJobCommand).resolves({
      Job: {
        Name: 'j',
        Role: 'arn:aws:iam::111111111111:role/r',
        Command: { Name: 'glueetl', ScriptLocation: 's3://b/s.py' },
        Timeout: 999,
        MaxCapacity: 10,
        AllocatedCapacity: 10, // deprecated duplicate — must NOT be re-sent
      },
    } as never);
    glue.on(UpdateJobCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Job'](ctx({ physicalId: 'j' }), [timeoutOp(480)]);
    const input = glue.commandCalls(UpdateJobCommand)[0]!.args[0].input as unknown as {
      JobUpdate: Record<string, unknown>;
    };
    expect(input.JobUpdate.MaxCapacity).toBe(10);
    expect('AllocatedCapacity' in input.JobUpdate).toBe(false);
  });

  it('#1568: an op REMOVING WorkerType lands in the fixed one-capacity branch', async () => {
    // Reverting an out-of-band WorkerType (undeclared, not in baseline) removes it from
    // the model — the post-ops job is a non-WorkerType job, whose GetJob echo pair must
    // still collapse to a single capacity form.
    glue.on(GetJobCommand).resolves({
      Job: {
        Name: 'j',
        Role: 'arn:aws:iam::111111111111:role/r',
        Command: { Name: 'glueetl', ScriptLocation: 's3://b/s.py' },
        WorkerType: 'G.1X',
        NumberOfWorkers: 10,
        MaxCapacity: 10,
        AllocatedCapacity: 10,
      },
    } as never);
    glue.on(UpdateJobCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Job'](ctx({ physicalId: 'j' }), [
      { op: 'remove', path: '/WorkerType', human: 'WorkerType -> remove' },
      { op: 'remove', path: '/NumberOfWorkers', human: 'NumberOfWorkers -> remove' },
    ]);
    const input = glue.commandCalls(UpdateJobCommand)[0]!.args[0].input as unknown as {
      JobUpdate: Record<string, unknown>;
    };
    expect('WorkerType' in input.JobUpdate).toBe(false);
    expect(input.JobUpdate.MaxCapacity).toBe(10);
    expect('AllocatedCapacity' in input.JobUpdate).toBe(false);
  });

  it('#1568: an ancient AllocatedCapacity-only job still round-trips its capacity', async () => {
    glue.on(GetJobCommand).resolves({
      Job: {
        Name: 'j',
        Role: 'arn:aws:iam::111111111111:role/r',
        Command: { Name: 'glueetl' },
        Timeout: 20,
        AllocatedCapacity: 2,
      },
    } as never);
    glue.on(UpdateJobCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Job'](ctx({ physicalId: 'j' }), [timeoutOp(10)]);
    const input = glue.commandCalls(UpdateJobCommand)[0]!.args[0].input as unknown as {
      JobUpdate: Record<string, unknown>;
    };
    expect(input.JobUpdate.AllocatedCapacity).toBe(2);
    expect('MaxCapacity' in input.JobUpdate).toBe(false);
  });

  it('throws when the job name is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::Glue::Job'](ctx({ physicalId: '', declared: {} }), [timeoutOp(10)])
    ).rejects.toThrow(/Glue job name/);
  });
});

describe('Glue Table writer (CC cannot read/write the Glue family)', () => {
  const descOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/TableInput/Description',
    value,
    human: 'TableInput.Description -> deployed-template value',
  });
  it('reverts via GetTable -> UpdateTable, rebuilding the full desired TableInput', async () => {
    glue.on(GetTableCommand).resolves({
      Table: {
        Name: 't',
        Description: 'CHANGED out of band',
        TableType: 'EXTERNAL_TABLE',
        Parameters: { classification: 'json' },
        StorageDescriptor: { Location: 's3://b/t/' },
      },
    } as never);
    glue.on(UpdateTableCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Table'](
      ctx({ physicalId: 'db|t', declared: { DatabaseName: 'db' } }),
      [descOp('the declared description')]
    );
    const calls = glue.commandCalls(UpdateTableCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as {
      DatabaseName: string;
      TableInput: Record<string, unknown>;
    };
    expect(input.DatabaseName).toBe('db');
    expect(input.TableInput.Name).toBe('t');
    expect(input.TableInput.Description).toBe('the declared description'); // reverted
    expect(input.TableInput.TableType).toBe('EXTERNAL_TABLE'); // round-tripped
    expect((input.TableInput.Parameters as Record<string, string>).classification).toBe('json');
  });

  it('throws when the table target is unresolvable', async () => {
    glue.on(GetTableCommand).resolves({ Table: undefined } as never);
    await expect(
      SDK_WRITERS['AWS::Glue::Table'](ctx({ physicalId: '', declared: {} }), [descOp('x')])
    ).rejects.toThrow(/Glue table target/);
  });
});

describe('Glue Classifier writer (CC UnsupportedActionException)', () => {
  const delimOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/CsvClassifier/Delimiter',
    value,
    human: 'CsvClassifier.Delimiter -> deployed-template value',
  });
  it('reverts via GetClassifier -> UpdateClassifier, writing back the one-of member', async () => {
    glue.on(GetClassifierCommand).resolves({
      Classifier: {
        CsvClassifier: { Name: 'c', Delimiter: '|', QuoteSymbol: '"', Version: 2 },
      },
    } as never);
    glue.on(UpdateClassifierCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Classifier'](
      ctx({ physicalId: 'c', declared: { CsvClassifier: { Name: 'c', Delimiter: ',' } } }),
      [delimOp(',')]
    );
    const calls = glue.commandCalls(UpdateClassifierCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as { CsvClassifier: Record<string, unknown> };
    expect(input.CsvClassifier.Name).toBe('c');
    expect(input.CsvClassifier.Delimiter).toBe(','); // reverted
    expect(input.CsvClassifier.QuoteSymbol).toBe('"'); // round-tripped
    expect(input.CsvClassifier).not.toHaveProperty('Version'); // managed field dropped by reader
  });

  it('throws when no classifier member can be resolved', async () => {
    glue.on(GetClassifierCommand).resolves({ Classifier: undefined } as never);
    await expect(
      SDK_WRITERS['AWS::Glue::Classifier'](ctx({ physicalId: '', declared: {} }), [delimOp('x')])
    ).rejects.toThrow(/Glue classifier target/);
  });
});

describe('Glue Workflow writer (CC UnsupportedActionException)', () => {
  const runsOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/MaxConcurrentRuns',
    value,
    human: 'MaxConcurrentRuns -> deployed-template value',
  });
  it('reverts via GetWorkflow -> UpdateWorkflow, writing back ALL mutable fields (no wipe)', async () => {
    glue.on(GetWorkflowCommand).resolves({
      Workflow: {
        Name: 'w',
        Description: 'etl',
        DefaultRunProperties: { env: 'test' },
        MaxConcurrentRuns: 7,
      },
    } as never);
    glue.on(UpdateWorkflowCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Workflow'](ctx({ physicalId: 'w', declared: { Name: 'w' } }), [
      runsOp(3),
    ]);
    const calls = glue.commandCalls(UpdateWorkflowCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.Name).toBe('w');
    expect(input.MaxConcurrentRuns).toBe(3); // reverted
    // the other live fields are re-sent so UpdateWorkflow's whole-object overwrite never wipes them
    expect(input.Description).toBe('etl');
    expect(input.DefaultRunProperties).toEqual({ env: 'test' });
  });

  it('clears an OOB-added Description / DefaultRunProperties on a remove, not a silent drop (#913)', async () => {
    glue.on(GetWorkflowCommand).resolves({
      Workflow: {
        Name: 'w',
        Description: 'oob',
        DefaultRunProperties: { env: 'oob' },
        MaxConcurrentRuns: 7,
      },
    } as never);
    glue.on(UpdateWorkflowCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Workflow'](ctx({ physicalId: 'w', declared: { Name: 'w' } }), [
      { op: 'remove', path: '/Description', human: 'Description -> (none)' },
      { op: 'remove', path: '/DefaultRunProperties', human: 'DefaultRunProperties -> (none)' },
    ]);
    const input = glue.commandCalls(UpdateWorkflowCommand)[0]!.args[0].input as unknown as Record<
      string,
      unknown
    >;
    // explicit clearing values — a selective UpdateWorkflow would keep the live value if omitted
    expect(input.Description).toBe('');
    expect(input.DefaultRunProperties).toEqual({});
    // the untouched live value is still re-sent so the whole-object overwrite never wipes it
    expect(input.MaxConcurrentRuns).toBe(7);
  });

  it('bars a MaxConcurrentRuns remove honestly ("no limit" is not expressible, #913)', async () => {
    glue
      .on(GetWorkflowCommand)
      .resolves({ Workflow: { Name: 'w', MaxConcurrentRuns: 7 } } as never);
    await expect(
      SDK_WRITERS['AWS::Glue::Workflow'](ctx({ physicalId: 'w', declared: { Name: 'w' } }), [
        { op: 'remove', path: '/MaxConcurrentRuns', human: 'MaxConcurrentRuns -> (none)' },
      ])
    ).rejects.toThrow(/MaxConcurrentRuns cannot be cleared/);
    expect(glue.commandCalls(UpdateWorkflowCommand)).toHaveLength(0);
  });

  it('throws when the workflow name is unresolvable', async () => {
    glue.on(GetWorkflowCommand).resolves({ Workflow: undefined } as never);
    await expect(
      SDK_WRITERS['AWS::Glue::Workflow'](ctx({ physicalId: '', declared: {} }), [runsOp(3)])
    ).rejects.toThrow(/Glue workflow target/);
  });
});

describe('Glue Connection writer (CC read gap; credential-safe UpdateConnection overwrite)', () => {
  // A NETWORK connection carries no inline credential — the safe case.
  const liveConn = {
    Name: 'conn',
    ConnectionType: 'NETWORK',
    Description: 'drifted desc',
    PhysicalConnectionRequirements: {
      SubnetId: 'subnet-1',
      SecurityGroupIdList: ['sg-1'],
      AvailabilityZone: 'us-east-1a',
    },
  };
  const descOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/ConnectionInput/Description',
    value,
    human: 'ConnectionInput.Description -> deployed-template value',
  });
  it('reverts a NETWORK connection via GetConnection -> UpdateConnection (whole ConnectionInput)', async () => {
    glue.on(GetConnectionCommand).resolves({ Connection: liveConn } as never);
    glue.on(UpdateConnectionCommand).resolves({});
    await SDK_WRITERS['AWS::Glue::Connection'](
      ctx({ physicalId: 'conn', declared: { ConnectionInput: { Name: 'conn' } } }),
      [descOp('intended desc')]
    );
    const calls = glue.commandCalls(UpdateConnectionCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.Name).toBe('conn');
    const ci = input.ConnectionInput as Record<string, unknown>;
    expect(ci.Description).toBe('intended desc'); // reverted
    // whole-ConnectionInput overwrite re-sends the other live fields (no wipe)
    expect(ci.ConnectionType).toBe('NETWORK');
    expect(ci.PhysicalConnectionRequirements).toEqual(liveConn.PhysicalConnectionRequirements);
    expect(ci.ConnectionProperties).toEqual({}); // required by the API; NETWORK has none
  });

  it('REFUSES (throws) a connection that declares an inline PASSWORD — never clobbers the credential', async () => {
    await expect(
      SDK_WRITERS['AWS::Glue::Connection'](
        ctx({
          physicalId: 'jdbc',
          declared: {
            ConnectionInput: {
              Name: 'jdbc',
              ConnectionProperties: { USERNAME: 'u', PASSWORD: 'p', JDBC_CONNECTION_URL: 'x' },
            },
          },
        }),
        [descOp('x')]
      )
    ).rejects.toThrow(/inline PASSWORD/);
    // the guard fires BEFORE any read/write — no UpdateConnection attempted
    expect(glue.commandCalls(UpdateConnectionCommand)).toHaveLength(0);
  });

  it('throws when the connection target is unresolvable', async () => {
    glue.on(GetConnectionCommand).resolves({ Connection: undefined } as never);
    await expect(
      SDK_WRITERS['AWS::Glue::Connection'](ctx({ physicalId: '', declared: {} }), [])
    ).rejects.toThrow(/Glue connection target/);
  });
});

describe('SES ReceiptRule writer (CC has no handlers; UpdateReceiptRule whole-rule overwrite)', () => {
  const liveRule = {
    Name: 'my-rule',
    Enabled: true,
    TlsPolicy: 'Optional',
    ScanEnabled: false,
    Recipients: ['drifted.example.com'],
    Actions: [{ AddHeaderAction: { HeaderName: 'X-Cdkrd', HeaderValue: 'v' } }],
  };
  const recipientsOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/Rule/Recipients',
    value,
    human: 'Rule.Recipients -> deployed-template value',
  });
  it('reverts via DescribeReceiptRule -> UpdateReceiptRule, re-sending the WHOLE Rule (no wipe)', async () => {
    ses.on(DescribeReceiptRuleCommand).resolves({ Rule: liveRule } as never);
    ses.on(UpdateReceiptRuleCommand).resolves({});
    await SDK_WRITERS['AWS::SES::ReceiptRule'](
      ctx({ physicalId: 'my-rule', declared: { RuleSetName: 'rs' } }),
      [recipientsOp(['example.com'])]
    );
    const calls = ses.commandCalls(UpdateReceiptRuleCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.RuleSetName).toBe('rs'); // parent targets the rule (createOnly)
    const rule = input.Rule as Record<string, unknown>;
    expect(rule.Recipients).toEqual(['example.com']); // reverted
    // the other live fields are re-sent so the whole-rule overwrite never wipes them
    // (a never-declared Enabled is NOT reset to the SES create-default false)
    expect(rule.Name).toBe('my-rule');
    expect(rule.Enabled).toBe(true);
    expect(rule.TlsPolicy).toBe('Optional');
    expect(rule.Actions).toEqual([
      { AddHeaderAction: { HeaderName: 'X-Cdkrd', HeaderValue: 'v' } },
    ]);
  });

  it('throws when the rule target is unresolvable', async () => {
    ses.on(DescribeReceiptRuleCommand).resolves({ Rule: undefined } as never);
    await expect(
      SDK_WRITERS['AWS::SES::ReceiptRule'](ctx({ physicalId: '', declared: {} }), [])
    ).rejects.toThrow(/SES receipt rule target/);
  });
});

describe('Logs MetricFilter writer (CC GetResource ValidationException on composite id)', () => {
  const reader = (filterPattern: string): void => {
    logs.on(DescribeMetricFiltersCommand).resolves({
      metricFilters: [
        {
          filterName: 'f',
          filterPattern,
          metricTransformations: [
            { metricName: 'Errors', metricNamespace: 'App', metricValue: '1', defaultValue: 0 },
          ],
        },
      ],
    } as never);
  };
  const patternOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/FilterPattern',
    value,
    human: 'FilterPattern -> deployed-template value',
  });
  it('reverts via DescribeMetricFilters -> PutMetricFilter (upsert of the whole filter)', async () => {
    reader('"CHANGED"');
    logs.on(PutMetricFilterCommand).resolves({});
    await SDK_WRITERS['AWS::Logs::MetricFilter'](
      ctx({ physicalId: 'f', declared: { LogGroupName: '/aws/lambda/x' } }),
      [patternOp('"ERROR"')]
    );
    const calls = logs.commandCalls(PutMetricFilterCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as {
      logGroupName: string;
      filterName: string;
      filterPattern: string;
      metricTransformations: Record<string, unknown>[];
    };
    expect(input.logGroupName).toBe('/aws/lambda/x');
    expect(input.filterName).toBe('f');
    expect(input.filterPattern).toBe('"ERROR"'); // reverted
    expect(input.metricTransformations[0]!.metricName).toBe('Errors'); // round-tripped
    expect(input.metricTransformations[0]!.defaultValue).toBe(0);
  });

  it('throws when the filter target is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::Logs::MetricFilter'](ctx({ physicalId: '', declared: {} }), [
        patternOp('"x"'),
      ])
    ).rejects.toThrow(/metric filter target/);
  });
});

describe('Route53 RecordSet writer (CC cannot read/write; reverts via ChangeResourceRecordSets UPSERT)', () => {
  const ttlOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/TTL',
    value,
    human: 'TTL -> deployed-template value',
  });
  const decl = { HostedZoneId: 'Z123', Name: 'a.example.test.', Type: 'A' };
  it('reverts a simple A-record TTL via UPSERT, rebuilding ResourceRecords as {Value}', async () => {
    // reader (ListResourceRecordSets) returns the live record with the CHANGED TTL
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: 'a.example.test.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '1.2.3.4' }] },
      ],
      IsTruncated: false,
    } as never);
    route53.on(ChangeResourceRecordSetsCommand).resolves({});
    await SDK_WRITERS['AWS::Route53::RecordSet'](
      ctx({ physicalId: 'Z123_a.example.test._A', declared: decl }),
      [ttlOp('300')]
    );
    const calls = route53.commandCalls(ChangeResourceRecordSetsCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as {
      HostedZoneId: string;
      ChangeBatch: { Changes: { Action: string; ResourceRecordSet: Record<string, unknown> }[] };
    };
    expect(input.HostedZoneId).toBe('Z123');
    const ch = input.ChangeBatch.Changes[0]!;
    expect(ch.Action).toBe('UPSERT');
    expect(ch.ResourceRecordSet.Name).toBe('a.example.test.');
    expect(ch.ResourceRecordSet.Type).toBe('A');
    expect(ch.ResourceRecordSet.TTL).toBe(300); // reverted, coerced string->number
    expect(ch.ResourceRecordSet.ResourceRecords).toEqual([{ Value: '1.2.3.4' }]); // rebuilt
  });

  it('throws when the record target is unresolvable', async () => {
    route53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [{ Name: 'a.example.test.', Type: 'A', TTL: 60 }],
      IsTruncated: false,
    } as never);
    await expect(
      SDK_WRITERS['AWS::Route53::RecordSet'](ctx({ physicalId: '', declared: {} }), [ttlOp('300')])
    ).rejects.toThrow(/Route53 record target/);
  });
});

describe('WAFv2 WebACL writer (CC UpdateResource rejects on empty Description)', () => {
  const PID = 'cdkrd-acl|abc-123|REGIONAL';
  const sampledOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/VisibilityConfig/SampledRequestsEnabled',
    value,
    human: 'VisibilityConfig.SampledRequestsEnabled -> deployed-template value',
  });
  it('reverts via GetWebACL -> apply ops -> UpdateWebACL, OMITTING the empty Description', async () => {
    // AWS returns Description: "" (empty); re-sending it via CC UpdateResource fails the
    // schema pattern. The writer omits it and re-sends every other updatable field.
    wafv2.on(GetWebACLCommand).resolves({
      LockToken: 'LOCK1',
      WebACL: {
        Name: 'cdkrd-acl',
        Id: 'abc-123',
        ARN: 'arn:aws:wafv2:us-east-1:111111111111:regional/webacl/cdkrd-acl/abc-123',
        Description: '',
        DefaultAction: { Allow: {} },
        Rules: [{ Name: 'r1', Priority: 0 }],
        VisibilityConfig: {
          SampledRequestsEnabled: false,
          CloudWatchMetricsEnabled: true,
          MetricName: 'm',
        },
      },
    } as never);
    wafv2.on(UpdateWebACLCommand).resolves({});
    await SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [sampledOp(true)]);
    const calls = wafv2.commandCalls(UpdateWebACLCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.Name).toBe('cdkrd-acl');
    expect(input.Id).toBe('abc-123');
    expect(input.Scope).toBe('REGIONAL');
    expect(input.LockToken).toBe('LOCK1');
    // the empty Description is OMITTED (the bug trigger)
    expect('Description' in input).toBe(false);
    // the reverted scalar is applied; Rules/DefaultAction round-trip verbatim
    expect(
      (input.VisibilityConfig as { SampledRequestsEnabled: boolean }).SampledRequestsEnabled
    ).toBe(true);
    expect(input.DefaultAction).toEqual({ Allow: {} });
    expect(input.Rules).toEqual([{ Name: 'r1', Priority: 0 }]);
  });

  it('keeps a NON-empty Description (only the empty one is dropped)', async () => {
    wafv2.on(GetWebACLCommand).resolves({
      LockToken: 'LOCK1',
      WebACL: {
        Name: 'cdkrd-acl',
        Id: 'abc-123',
        Description: 'real description',
        DefaultAction: { Allow: {} },
        VisibilityConfig: {
          SampledRequestsEnabled: false,
          CloudWatchMetricsEnabled: true,
          MetricName: 'm',
        },
      },
    } as never);
    wafv2.on(UpdateWebACLCommand).resolves({});
    await SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [sampledOp(true)]);
    expect(
      (
        wafv2.commandCalls(UpdateWebACLCommand)[0]!.args[0].input as unknown as Record<
          string,
          unknown
        >
      ).Description
    ).toBe('real description');
  });

  it('aligns Rules to the canonicalized (Name-sorted) index before applying ops', async () => {
    // classify SORTS Rules by Name (every rule carries one), so a finding op path indexes
    // the sorted array. GetWebACL returns Rules in RAW configured order — here declared out
    // of Name order ([zeta, alpha]) so the sorted order ([alpha, zeta]) differs. An op on
    // the SECOND sorted rule (zeta, index 1) must land on zeta, NOT on whatever sits at raw
    // index 1 (alpha). Without canonicalizing cur.WebACL first, the patch would corrupt the
    // wrong (security-relevant) rule and leave the real drift unreverted (#180/#275 class).
    wafv2.on(GetWebACLCommand).resolves({
      LockToken: 'LOCK1',
      WebACL: {
        Name: 'cdkrd-acl',
        Id: 'abc-123',
        DefaultAction: { Allow: {} },
        // RAW order: zeta first, alpha second (user declared rules out of Name order)
        Rules: [
          { Name: 'zeta', Priority: 0, Action: { Allow: {} } },
          { Name: 'alpha', Priority: 1, Action: { Block: {} } },
        ],
        VisibilityConfig: {
          SampledRequestsEnabled: false,
          CloudWatchMetricsEnabled: true,
          MetricName: 'm',
        },
      },
    } as never);
    wafv2.on(UpdateWebACLCommand).resolves({});
    // op targets the SORTED index 1 (= zeta): set its Action to Block
    const ruleActionOp: PatchOp = {
      op: 'add',
      path: '/Rules/1/Action',
      value: { Block: {} },
      human: 'Rules.1.Action -> deployed-template value',
    };
    await SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [ruleActionOp]);
    const input = wafv2.commandCalls(UpdateWebACLCommand)[0]!.args[0].input as unknown as {
      Rules: { Name: string; Action: unknown }[];
    };
    // re-sent Rules are in sorted (alpha, zeta) order; the op hit ZETA (its Action is now
    // Block), and ALPHA is untouched — proving the index aligned to the sorted model.
    const zeta = input.Rules.find((r) => r.Name === 'zeta')!;
    const alpha = input.Rules.find((r) => r.Name === 'alpha')!;
    expect(zeta.Action).toEqual({ Block: {} });
    expect(alpha.Action).toEqual({ Block: {} }); // alpha was already Block, unchanged
    expect(input.Rules.map((r) => r.Name)).toEqual(['alpha', 'zeta']);
  });

  it('throws when the Name|Id|Scope physical id is malformed', async () => {
    await expect(
      SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: 'just-a-name' }), [sampledOp(true)])
    ).rejects.toThrow(/Name\|Id\|Scope/);
  });
});

describe('CloudFront Distribution writer (CC UpdateResource rejects partial patch)', () => {
  const ID = 'E123ABC';
  const commentOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/DistributionConfig/Comment',
    value,
    human: 'Comment -> deployed-template value',
  });
  it('reverts via GetDistributionConfig -> apply ops -> UpdateDistribution(IfMatch=ETag)', async () => {
    // GetDistributionConfig returns the DRIFTED live config + ETag; UpdateDistribution
    // re-submits the SAME config with only the reverted scalar changed (round-trips the
    // default ViewerCertificate verbatim, which the CC partial patch could not).
    cloudfront.on(GetDistributionConfigCommand).resolves({
      ETag: 'ETAG1',
      // partial live config stub (the writer round-trips it verbatim) — cast past the
      // full DistributionConfig required-field type for the test.
      DistributionConfig: {
        CallerReference: 'r',
        Comment: 'DRIFTED',
        Enabled: true,
        ViewerCertificate: { CloudFrontDefaultCertificate: true },
        Origins: { Quantity: 1, Items: [{ Id: 'o1', DomainName: 'a.example.com' }] },
      } as never,
    });
    cloudfront.on(UpdateDistributionCommand).resolves({});
    await SDK_WRITERS['AWS::CloudFront::Distribution'](ctx({ physicalId: ID }), [
      commentOp('the desired comment'),
    ]);
    const calls = cloudfront.commandCalls(UpdateDistributionCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as {
      Id: string;
      IfMatch: string;
      DistributionConfig: { Comment: string; ViewerCertificate: unknown; Origins: unknown };
    };
    expect(input.Id).toBe(ID);
    expect(input.IfMatch).toBe('ETAG1');
    // only Comment changed; the rest of the live config round-trips verbatim
    expect(input.DistributionConfig.Comment).toBe('the desired comment');
    expect(input.DistributionConfig.ViewerCertificate).toEqual({
      CloudFrontDefaultCertificate: true,
    });
    expect(input.DistributionConfig.Origins).toEqual({
      Quantity: 1,
      Items: [{ Id: 'o1', DomainName: 'a.example.com' }],
    });
  });

  it('throws when the distribution id is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::CloudFront::Distribution'](ctx({ physicalId: '' }), [commentOp('x')])
    ).rejects.toThrow(/distribution id/);
  });
});

describe('DocDB DBCluster writer (CC read+write gap)', () => {
  const CLID = 'my-cluster';
  const retentionOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/BackupRetentionPeriod',
    value,
    human: 'BackupRetentionPeriod -> deployed-template value',
  });
  // the override reader (DescribeDBClusters) returns the DRIFTED live model
  const stubClusterRead = (over: Record<string, unknown> = {}): void => {
    docdb.on(DescribeDBClustersCommand).resolves({
      DBClusters: [{ DBClusterIdentifier: CLID, BackupRetentionPeriod: 5, ...over }],
    });
  };

  it('reverts BackupRetentionPeriod via ModifyDBCluster (ApplyImmediately), only the drifted prop', async () => {
    stubClusterRead();
    docdb.on(ModifyDBClusterCommand).resolves({});
    await SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [retentionOp(3)]);
    const calls = docdb.commandCalls(ModifyDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      DBClusterIdentifier: CLID,
      ApplyImmediately: true,
      BackupRetentionPeriod: 3,
    });
  });

  it('does NOT send EngineVersion (off the safe-modify allowlist) AND reports it not-reverted (#804)', async () => {
    stubClusterRead({ EngineVersion: '4.0.0' });
    docdb.on(ModifyDBClusterCommand).resolves({});
    // EngineVersion is off the safe-modify allowlist (a version write can trigger an upgrade),
    // so no ModifyDBCluster is sent — but before #804 the writer also printed a false
    // `reverted:`. It now throws so the finding stays surfaced as not-reverted.
    await expect(
      SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [
        { op: 'add', path: '/EngineVersion', value: '5.0.0', human: 'x' },
      ])
    ).rejects.toThrow(/EngineVersion/);
    expect(docdb.commandCalls(ModifyDBClusterCommand)).toHaveLength(0);
  });

  it('clears an OOB-added DeletionProtection on a remove (explicit false), not a silent drop (#984)', async () => {
    stubClusterRead({ DeletionProtection: true });
    docdb.on(ModifyDBClusterCommand).resolves({});
    await SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [
      { op: 'remove', path: '/DeletionProtection', human: 'DeletionProtection -> (none)' },
    ]);
    const calls = docdb.commandCalls(ModifyDBClusterCommand);
    expect(calls).toHaveLength(1);
    // an omitted DeletionProtection would keep the live `true` (selective ModifyDBCluster) — the
    // revert must send an explicit `false` so protection actually clears
    expect(calls[0]!.args[0].input).toEqual({
      DBClusterIdentifier: CLID,
      ApplyImmediately: true,
      DeletionProtection: false,
    });
  });

  it('bars a BackupRetentionPeriod remove honestly (AWS-assigned unset, not expressible, #984)', async () => {
    stubClusterRead();
    await expect(
      SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [
        { op: 'remove', path: '/BackupRetentionPeriod', human: 'BackupRetentionPeriod -> (none)' },
      ])
    ).rejects.toThrow(/BackupRetentionPeriod cannot be cleared/);
    // never a silent no-op that reports success
    expect(docdb.commandCalls(ModifyDBClusterCommand)).toHaveLength(0);
  });

  it('throws when the cluster identifier is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: '', declared: {} }), [retentionOp(3)])
    ).rejects.toThrow(/cluster identifier/);
  });
});

describe('DocDB DBInstance writer (CC read+write gap; mirror of the cluster writer)', () => {
  const IID = 'cdkrd-docdb-instance';
  const windowOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/PreferredMaintenanceWindow',
    value,
    human: 'PreferredMaintenanceWindow -> deployed-template value',
  });
  const stubInstanceRead = (over: Record<string, unknown> = {}): void => {
    docdb.on(DescribeDBInstancesCommand).resolves({
      DBInstances: [
        { DBInstanceIdentifier: IID, PreferredMaintenanceWindow: 'mon:07:00-mon:08:00', ...over },
      ],
    });
  };
  it('reverts PreferredMaintenanceWindow via ModifyDBInstance (ApplyImmediately), only the drifted prop', async () => {
    stubInstanceRead();
    docdb.on(ModifyDBInstanceCommand).resolves({});
    await SDK_WRITERS['AWS::DocDB::DBInstance'](ctx({ physicalId: IID }), [
      windowOp('sun:05:00-sun:06:00'),
    ]);
    const calls = docdb.commandCalls(ModifyDBInstanceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      DBInstanceIdentifier: IID,
      ApplyImmediately: true,
      PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
    });
  });

  it('reports an op off the safe-modify allowlist as NOT reverted, not a silent success (#804)', async () => {
    stubInstanceRead({ AutoMinorVersionUpgrade: true });
    docdb.on(ModifyDBInstanceCommand).resolves({});
    // AutoMinorVersionUpgrade is OFF the instance allowlist (a cluster-managed setting
    // ModifyDBInstance rejects). Before #804 the writer dropped it silently and the run
    // printed a false `reverted:`; now it throws so the finding stays surfaced as not-reverted.
    await expect(
      SDK_WRITERS['AWS::DocDB::DBInstance'](ctx({ physicalId: IID }), [
        { op: 'add', path: '/AutoMinorVersionUpgrade', value: false, human: 'x' },
      ])
    ).rejects.toThrow(/AutoMinorVersionUpgrade/);
    // No convergeable op was present, so no Modify call was sent.
    expect(docdb.commandCalls(ModifyDBInstanceCommand)).toHaveLength(0);
  });

  it('clears an OOB-added EnablePerformanceInsights on a remove (explicit false), not a silent drop (#984)', async () => {
    stubInstanceRead({ EnablePerformanceInsights: true });
    docdb.on(ModifyDBInstanceCommand).resolves({});
    await SDK_WRITERS['AWS::DocDB::DBInstance'](ctx({ physicalId: IID }), [
      {
        op: 'remove',
        path: '/EnablePerformanceInsights',
        human: 'EnablePerformanceInsights -> (none)',
      },
    ]);
    const calls = docdb.commandCalls(ModifyDBInstanceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      DBInstanceIdentifier: IID,
      ApplyImmediately: true,
      EnablePerformanceInsights: false,
    });
  });

  it('bars a PreferredMaintenanceWindow remove honestly (AWS-assigned unset, not expressible, #984)', async () => {
    stubInstanceRead();
    await expect(
      SDK_WRITERS['AWS::DocDB::DBInstance'](ctx({ physicalId: IID }), [
        {
          op: 'remove',
          path: '/PreferredMaintenanceWindow',
          human: 'PreferredMaintenanceWindow -> (none)',
        },
      ])
    ).rejects.toThrow(/PreferredMaintenanceWindow cannot be cleared/);
    expect(docdb.commandCalls(ModifyDBInstanceCommand)).toHaveLength(0);
  });

  it('throws when the instance identifier is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::DocDB::DBInstance'](ctx({ physicalId: '', declared: {} }), [
        windowOp('sun:05:00-sun:06:00'),
      ])
    ).rejects.toThrow(/instance identifier/);
  });
});

describe('ElasticBeanstalk Application/Environment writers (CC UpdateResource ServiceRole FP)', () => {
  const descOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/Description',
    value,
    human: 'Description -> deployed-template value',
  });

  it('reverts an Application Description via UpdateApplication (declared value, only the drifted prop)', async () => {
    eb.on(UpdateApplicationCommand).resolves({});
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({
        physicalId: 'my-app',
        declared: { ApplicationName: 'my-app', Description: 'declared' },
      }),
      [descOp('declared')]
    );
    const calls = eb.commandCalls(UpdateApplicationCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({ ApplicationName: 'my-app', Description: 'declared' });
  });

  it('a remove op clears the Application Description (empty string)', async () => {
    eb.on(UpdateApplicationCommand).resolves({});
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({ physicalId: 'my-app', declared: { ApplicationName: 'my-app' } }),
      [{ op: 'remove', path: '/Description', human: 'clear Description' }]
    );
    expect(eb.commandCalls(UpdateApplicationCommand)[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      Description: '',
    });
  });

  it('reverts an Environment Description via UpdateEnvironment', async () => {
    eb.on(UpdateEnvironmentCommand).resolves({});
    await SDK_WRITERS['AWS::ElasticBeanstalk::Environment'](
      ctx({
        physicalId: 'my-env',
        declared: { EnvironmentName: 'my-env', Description: 'declared' },
      }),
      [descOp('declared')]
    );
    const calls = eb.commandCalls(UpdateEnvironmentCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({ EnvironmentName: 'my-env', Description: 'declared' });
  });

  it('an off-allowlist prop (create-only Tier) sends NO update AND is reported not-reverted (#804)', async () => {
    eb.on(UpdateEnvironmentCommand).resolves({});
    // Tier is off the allowlist (create-only) — no UpdateEnvironment is sent (never accidentally
    // mutated) — but before #804 the writer printed a false `reverted:`. It now throws so the
    // finding stays surfaced as not-reverted.
    await expect(
      SDK_WRITERS['AWS::ElasticBeanstalk::Environment'](
        ctx({ physicalId: 'my-env', declared: { EnvironmentName: 'my-env' } }),
        [{ op: 'add', path: '/Tier', value: { Name: 'Worker' }, human: 'x' }]
      )
    ).rejects.toThrow(/Tier/);
    expect(eb.commandCalls(UpdateEnvironmentCommand)).toHaveLength(0);
  });

  it('throws when the Application name is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::ElasticBeanstalk::Application'](ctx({ physicalId: '', declared: {} }), [
        descOp('x'),
      ])
    ).rejects.toThrow(/ApplicationName/);
  });

  // #1295 — ResourceLifecycleConfig is mutable out of band and folds atDefault when undeclared.
  // Its revert op used to hit the #804 assertOpsConsumed honest-fail (UpdateApplication cannot
  // set it); it now routes through UpdateApplicationResourceLifecycle and converges.
  const DEFAULT_RLC = {
    VersionLifecycleConfig: {
      MaxCountRule: { DeleteSourceFromS3: false, Enabled: false, MaxCount: 200 },
      MaxAgeRule: { DeleteSourceFromS3: false, MaxAgeInDays: 180, Enabled: false },
    },
  };
  const enabledRLC = {
    VersionLifecycleConfig: {
      MaxCountRule: { DeleteSourceFromS3: true, Enabled: true, MaxCount: 5 },
    },
  };

  it('reverts an undeclared, at-default ResourceLifecycleConfig (remove op) to the service default via UpdateApplicationResourceLifecycle', async () => {
    eb.on(UpdateApplicationResourceLifecycleCommand).resolves({});
    // The undeclared prop folded atDefault, drifted out of band, and the revert plan emits a
    // `remove` (desired = absent/default). The writer must NOT honest-fail; it writes the default.
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({ physicalId: 'my-app', declared: { ApplicationName: 'my-app' } }),
      [
        {
          op: 'remove',
          path: '/ResourceLifecycleConfig',
          human: 'ResourceLifecycleConfig -> default',
        },
      ]
    );
    const calls = eb.commandCalls(UpdateApplicationResourceLifecycleCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      ResourceLifecycleConfig: DEFAULT_RLC,
    });
    // no UpdateApplication (Description) call was sent for a pure lifecycle revert
    expect(eb.commandCalls(UpdateApplicationCommand)).toHaveLength(0);
  });

  it('reverts a DECLARED ResourceLifecycleConfig drift (add op) to the declared intent', async () => {
    eb.on(UpdateApplicationResourceLifecycleCommand).resolves({});
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({
        physicalId: 'my-app',
        declared: { ApplicationName: 'my-app', ResourceLifecycleConfig: enabledRLC },
      }),
      [{ op: 'add', path: '/ResourceLifecycleConfig', value: enabledRLC, human: 'x' }]
    );
    expect(eb.commandCalls(UpdateApplicationResourceLifecycleCommand)[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      ResourceLifecycleConfig: enabledRLC,
    });
  });

  it('a nested-path add op still writes the WHOLE declared ResourceLifecycleConfig (not a leaf fragment)', async () => {
    eb.on(UpdateApplicationResourceLifecycleCommand).resolves({});
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({
        physicalId: 'my-app',
        declared: { ApplicationName: 'my-app', ResourceLifecycleConfig: enabledRLC },
      }),
      [
        {
          op: 'add',
          path: '/ResourceLifecycleConfig/VersionLifecycleConfig/MaxCountRule/Enabled',
          value: true,
          human: 'x',
        },
      ]
    );
    expect(eb.commandCalls(UpdateApplicationResourceLifecycleCommand)[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      ResourceLifecycleConfig: enabledRLC,
    });
  });

  it('#1437: an UNDECLARED nested set-default add (no declared config) writes the WHOLE default lifecycle, not the leaf fragment', async () => {
    eb.on(UpdateApplicationResourceLifecycleCommand).resolves({});
    // Post-#1437 an out-of-band lifecycle change surfaces at the DESCENDED nested path, so the
    // undeclared revert plan emits a set-default `add` at `/ResourceLifecycleConfig/
    // VersionLifecycleConfig` whose value is the VersionLifecycleConfig CONTENTS (no wrapper) and
    // there is NO declared config. The writer must reconstruct the whole default object — writing
    // op.value directly would send a wrapper-less fragment as the whole ResourceLifecycleConfig.
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({ physicalId: 'my-app', declared: { ApplicationName: 'my-app' } }),
      [
        {
          op: 'add',
          path: '/ResourceLifecycleConfig/VersionLifecycleConfig',
          value: DEFAULT_RLC.VersionLifecycleConfig,
          human: 'ResourceLifecycleConfig.VersionLifecycleConfig -> AWS default',
        },
      ]
    );
    const calls = eb.commandCalls(UpdateApplicationResourceLifecycleCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      ResourceLifecycleConfig: DEFAULT_RLC,
    });
  });

  it('applies Description AND ResourceLifecycleConfig in one op set (two distinct commands)', async () => {
    eb.on(UpdateApplicationCommand).resolves({});
    eb.on(UpdateApplicationResourceLifecycleCommand).resolves({});
    await SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
      ctx({
        physicalId: 'my-app',
        declared: { ApplicationName: 'my-app', Description: 'declared' },
      }),
      [
        descOp('declared'),
        {
          op: 'remove',
          path: '/ResourceLifecycleConfig',
          human: 'ResourceLifecycleConfig -> default',
        },
      ]
    );
    expect(eb.commandCalls(UpdateApplicationCommand)[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      Description: 'declared',
    });
    expect(eb.commandCalls(UpdateApplicationResourceLifecycleCommand)[0]!.args[0].input).toEqual({
      ApplicationName: 'my-app',
      ResourceLifecycleConfig: DEFAULT_RLC,
    });
  });

  it('still reports a truly off-allowlist prop (not Description/ResourceLifecycleConfig) not-reverted (#804)', async () => {
    eb.on(UpdateApplicationResourceLifecycleCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::ElasticBeanstalk::Application'](
        ctx({ physicalId: 'my-app', declared: { ApplicationName: 'my-app' } }),
        [{ op: 'add', path: '/ApplicationName', value: 'renamed', human: 'x' }]
      )
    ).rejects.toThrow(/ApplicationName/);
  });
});

describe('CodeBuild ReportGroup writer (NON_PROVISIONABLE; UpdateReportGroup, issue #552)', () => {
  const RG_ARN = 'arn:aws:codebuild:us-east-1:123456789012:report-group/cdkrd-rg';
  const packagingOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/ExportConfig/S3Destination/Packaging',
    value,
    human: 'ExportConfig.S3Destination.Packaging -> deployed-template value',
  });
  // the override reader (BatchGetReportGroups) returns the DRIFTED live model
  const stubRead = (over: Record<string, unknown> = {}): void => {
    codebuild.on(BatchGetReportGroupsCommand).resolves({
      reportGroups: [
        {
          name: 'cdkrd-rg',
          type: 'TEST',
          exportConfig: {
            exportConfigType: 'S3',
            s3Destination: { bucket: 'my-bucket', path: 'reports', packaging: 'ZIP' },
          },
          tags: [{ key: 'team', value: 'platform' }],
          ...over,
        },
      ],
    } as never);
  };

  it('reverts the ExportConfig packaging + re-sends tags via UpdateReportGroup', async () => {
    stubRead();
    codebuild.on(UpdateReportGroupCommand).resolves({});
    // revert Packaging back to NONE (drifted to ZIP out of band)
    await SDK_WRITERS['AWS::CodeBuild::ReportGroup'](ctx({ physicalId: RG_ARN }), [
      packagingOp('NONE'),
    ]);
    const calls = codebuild.commandCalls(UpdateReportGroupCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.arn).toBe(RG_ARN);
    expect(input.exportConfig).toEqual({
      exportConfigType: 'S3',
      s3Destination: {
        bucket: 'my-bucket',
        path: 'reports',
        packaging: 'NONE',
        encryptionKey: undefined,
        encryptionDisabled: undefined,
      },
    });
    // tags round-trip (camelCase key/value) so a Tags-only edit would not wipe them
    expect(input.tags).toEqual([{ key: 'team', value: 'platform' }]);
  });

  it('sends an empty tag list when the group has no tags (clears an out-of-band tag)', async () => {
    stubRead({ tags: undefined });
    codebuild.on(UpdateReportGroupCommand).resolves({});
    await SDK_WRITERS['AWS::CodeBuild::ReportGroup'](ctx({ physicalId: RG_ARN }), [
      packagingOp('NONE'),
    ]);
    expect(codebuild.commandCalls(UpdateReportGroupCommand)[0]!.args[0].input.tags).toEqual([]);
  });

  it('throws when the report-group ARN is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::CodeBuild::ReportGroup'](ctx({ physicalId: '', declared: {} }), [
        packagingOp('NONE'),
      ])
    ).rejects.toThrow(/ReportGroup ARN/);
  });
});

describe('DAX Cluster writer (NON_PROVISIONABLE; UpdateCluster partial modify, issue #552)', () => {
  const CN = 'cdkrd-dax';
  const descOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/Description',
    value,
    human: 'Description -> deployed-template value',
  });
  const stubRead = (over: Record<string, unknown> = {}): void => {
    dax.on(DescribeClustersCommand).resolves({
      Clusters: [
        { ClusterName: CN, Description: 'drifted desc', NodeType: 'dax.r5.large', ...over },
      ],
    } as never);
  };

  it('reverts Description via UpdateCluster, only the drifted prop mapped CFn->API', async () => {
    stubRead();
    dax.on(UpdateClusterCommand).resolves({});
    await SDK_WRITERS['AWS::DAX::Cluster'](ctx({ physicalId: CN }), [descOp('intended desc')]);
    const calls = dax.commandCalls(UpdateClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({ ClusterName: CN, Description: 'intended desc' });
  });

  it('maps NotificationTopicARN -> NotificationTopicArn and clears it on a remove', async () => {
    stubRead({ NotificationConfiguration: { TopicArn: 'arn:aws:sns:us-east-1:123456789012:t' } });
    dax.on(UpdateClusterCommand).resolves({});
    // a REMOVE (topic never declared → revert detaches it) sends the empty string DAX accepts
    await SDK_WRITERS['AWS::DAX::Cluster'](ctx({ physicalId: CN }), [
      { op: 'remove', path: '/NotificationTopicARN', human: 'NotificationTopicARN -> (none)' },
    ]);
    expect(dax.commandCalls(UpdateClusterCommand)[0]!.args[0].input).toEqual({
      ClusterName: CN,
      NotificationTopicArn: '',
    });
  });

  it('ignores a create-only prop off the modify allowlist (NodeType)', async () => {
    stubRead();
    dax.on(UpdateClusterCommand).resolves({});
    await SDK_WRITERS['AWS::DAX::Cluster'](ctx({ physicalId: CN }), [
      { op: 'add', path: '/NodeType', value: 'dax.r5.xlarge', human: 'x' },
    ]);
    expect(dax.commandCalls(UpdateClusterCommand)).toHaveLength(0);
  });

  it('clears a Description remove with "" instead of silently dropping it (#913)', async () => {
    stubRead();
    dax.on(UpdateClusterCommand).resolves({});
    await SDK_WRITERS['AWS::DAX::Cluster'](ctx({ physicalId: CN }), [
      { op: 'remove', path: '/Description', human: 'Description -> (none)' },
    ]);
    expect(dax.commandCalls(UpdateClusterCommand)[0]!.args[0].input).toEqual({
      ClusterName: CN,
      Description: '',
    });
  });

  it('bars a ParameterGroupName remove honestly (AWS-assigned unset, not expressible, #913)', async () => {
    stubRead();
    await expect(
      SDK_WRITERS['AWS::DAX::Cluster'](ctx({ physicalId: CN }), [
        { op: 'remove', path: '/ParameterGroupName', human: 'ParameterGroupName -> (none)' },
      ])
    ).rejects.toThrow(/ParameterGroupName cannot be cleared/);
    expect(dax.commandCalls(UpdateClusterCommand)).toHaveLength(0);
  });
});

describe('DAX ParameterGroup writer (NON_PROVISIONABLE; UpdateParameterGroup, issue #552)', () => {
  const PGN = 'cdkrd-dax-params';
  const stubRead = (values: Record<string, string>): void => {
    dax.on(DescribeParameterGroupsCommand).resolves({
      ParameterGroups: [{ ParameterGroupName: PGN, Description: 'd' }],
    } as never);
    dax.on(DescribeDaxParametersCommand).resolves({
      Parameters: Object.entries(values).map(([ParameterName, ParameterValue]) => ({
        ParameterName,
        ParameterValue,
        IsModifiable: 'TRUE',
      })),
    } as never);
  };

  it('re-asserts the drifted parameter (map -> [{ParameterName,ParameterValue}] list)', async () => {
    // desired value (record-ttl-millis) reads back 10000 after applying the revert op
    stubRead({ 'record-ttl-millis': '10000', 'query-ttl-millis': '5000' });
    dax.on(UpdateDaxParameterGroupCommand).resolves({});
    await SDK_WRITERS['AWS::DAX::ParameterGroup'](ctx({ physicalId: PGN }), [
      {
        op: 'add',
        path: '/ParameterNameValues/record-ttl-millis',
        value: '10000',
        human: 'ParameterNameValues.record-ttl-millis -> deployed-template value',
      },
    ]);
    const calls = dax.commandCalls(UpdateDaxParameterGroupCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      ParameterGroupName: PGN,
      // ONLY the drifted key is re-sent (UpdateParameterGroup leaves others untouched)
      ParameterNameValues: [{ ParameterName: 'record-ttl-millis', ParameterValue: '10000' }],
    });
  });

  it('sends nothing when no ParameterNameValues op is present', async () => {
    stubRead({ 'record-ttl-millis': '10000' });
    dax.on(UpdateDaxParameterGroupCommand).resolves({});
    await SDK_WRITERS['AWS::DAX::ParameterGroup'](ctx({ physicalId: PGN }), [
      { op: 'add', path: '/Description', value: 'x', human: 'x' },
    ]);
    expect(dax.commandCalls(UpdateDaxParameterGroupCommand)).toHaveLength(0);
  });

  it('THROWS on a `remove` op — DAX has no ResetParameterGroup API to clear a parameter (#1087)', async () => {
    // Reverting an out-of-band-ADDED parameter back to unset is UN-EXPRESSIBLE: UpdateParameterGroup
    // can only re-assert a value, never clear one. Silently returning here reported a false
    // `reverted:` while the parameter never cleared — throw loudly instead (#928/#1002/#1102 class).
    stubRead({ 'record-ttl-millis': '10000' });
    dax.on(UpdateDaxParameterGroupCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::DAX::ParameterGroup'](ctx({ physicalId: PGN }), [
        {
          op: 'remove',
          path: '/ParameterNameValues/record-ttl-millis',
          human: 'ParameterNameValues.record-ttl-millis -> unset (OOB-added)',
        },
      ])
    ).rejects.toThrow(/cannot be cleared via UpdateParameterGroup/);
    // and it must NOT have silently "succeeded" via an UpdateParameterGroup call for the remove
    expect(dax.commandCalls(UpdateDaxParameterGroupCommand)).toHaveLength(0);
  });

  it('THROWS on the mixed [remove k1, add k2] case rather than partially applying k2 and lying (#1087)', async () => {
    // The remove makes the whole item un-convergent; the convergeable add IS applied, but the
    // writer must still throw so the un-expressible remove is not reported as reverted.
    stubRead({ 'query-ttl-millis': '5000' });
    dax.on(UpdateDaxParameterGroupCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::DAX::ParameterGroup'](ctx({ physicalId: PGN }), [
        {
          op: 'remove',
          path: '/ParameterNameValues/record-ttl-millis',
          human: 'ParameterNameValues.record-ttl-millis -> unset (OOB-added)',
        },
        {
          op: 'add',
          path: '/ParameterNameValues/query-ttl-millis',
          value: '5000',
          human: 'ParameterNameValues.query-ttl-millis -> deployed-template value',
        },
      ])
    ).rejects.toThrow(/record-ttl-millis/);
    // the expressible add IS applied first (so the convergeable sibling still lands) ...
    const calls = dax.commandCalls(UpdateDaxParameterGroupCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      ParameterGroupName: PGN,
      ParameterNameValues: [{ ParameterName: 'query-ttl-millis', ParameterValue: '5000' }],
    });
  });

  it('THROWS on a whole-map `remove /ParameterNameValues` (--remove-unrecorded) — keys sourced from the LIVE map (#1087)', async () => {
    // An undeclared, unrecorded ParameterNameValues reverted with --remove-unrecorded plans a
    // WHOLE-PROPERTY remove. After applyOps the desired map is EMPTY, so the keys to (fail to)
    // clear are only knowable from the LIVE model. The CdkrdDaxVerify live-test caught the writer
    // silently no-op'ing here (false `reverted:`, only the #631 post-hoc detector flagged it)
    // because it enumerated the post-remove desired map. It must throw, naming the live keys.
    stubRead({ 'query-ttl-millis': '75000', 'record-ttl-millis': '300000' });
    dax.on(UpdateDaxParameterGroupCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::DAX::ParameterGroup'](ctx({ physicalId: PGN }), [
        {
          op: 'remove',
          path: '/ParameterNameValues',
          human: 'ParameterNameValues -> unset (undeclared, --remove-unrecorded)',
        },
      ])
    ).rejects.toThrow(/query-ttl-millis/);
    expect(dax.commandCalls(UpdateDaxParameterGroupCommand)).toHaveLength(0);
  });

  it('a whole-map `remove` when the live map is already EMPTY is a genuine no-op, not a throw (#1087)', async () => {
    // Nothing is set live, so "clear everything" clears nothing — must succeed silently.
    stubRead({});
    dax.on(UpdateDaxParameterGroupCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::DAX::ParameterGroup'](ctx({ physicalId: PGN }), [
        { op: 'remove', path: '/ParameterNameValues', human: 'ParameterNameValues -> unset' },
      ])
    ).resolves.toBeUndefined();
    expect(dax.commandCalls(UpdateDaxParameterGroupCommand)).toHaveLength(0);
  });
});

describe('ElastiCache ParameterGroup writer (source=user reader; Modify/Reset)', () => {
  const PGN = 'cdkrd-redis-params';
  const stubRead = (values: Record<string, string>): void => {
    elasticache.on(DescribeCacheParameterGroupsCommand).resolves({
      CacheParameterGroups: [
        { CacheParameterGroupName: PGN, CacheParameterGroupFamily: 'redis7', Description: 'd' },
      ],
    } as never);
    elasticache.on(DescribeCacheParametersCommand).resolves({
      Parameters: Object.entries(values).map(([ParameterName, ParameterValue]) => ({
        ParameterName,
        ParameterValue,
        Source: 'user',
      })),
    } as never);
  };

  it('a declared param drift -> ModifyCacheParameterGroup with the desired value only', async () => {
    // Current live reads timeout=500; the add op reverts it to the desired 300.
    stubRead({ timeout: '500', 'maxmemory-policy': 'allkeys-lru' });
    elasticache.on(ModifyCacheParameterGroupCommand).resolves({});
    await SDK_WRITERS['AWS::ElastiCache::ParameterGroup'](ctx({ physicalId: PGN }), [
      {
        op: 'add',
        path: '/Properties/timeout',
        value: '300',
        human: 'Properties.timeout -> deployed-template value',
      },
    ]);
    const modify = elasticache.commandCalls(ModifyCacheParameterGroupCommand);
    expect(modify).toHaveLength(1);
    expect(modify[0]!.args[0].input).toEqual({
      CacheParameterGroupName: PGN,
      ParameterNameValues: [{ ParameterName: 'timeout', ParameterValue: '300' }],
    });
    expect(elasticache.commandCalls(ResetCacheParameterGroupCommand)).toHaveLength(0);
  });

  it('an undeclared added param -> ResetCacheParameterGroup for that key (no modify)', async () => {
    stubRead({ 'maxmemory-policy': 'allkeys-lru', activedefrag: 'yes' });
    elasticache.on(ResetCacheParameterGroupCommand).resolves({});
    await SDK_WRITERS['AWS::ElastiCache::ParameterGroup'](ctx({ physicalId: PGN }), [
      {
        op: 'remove',
        path: '/Properties/activedefrag',
        human: 'Properties.activedefrag -> remove (undeclared, not in baseline)',
      },
    ]);
    const reset = elasticache.commandCalls(ResetCacheParameterGroupCommand);
    expect(reset).toHaveLength(1);
    expect(reset[0]!.args[0].input).toEqual({
      CacheParameterGroupName: PGN,
      ResetAllParameters: false,
      ParameterNameValues: [{ ParameterName: 'activedefrag' }],
    });
    expect(elasticache.commandCalls(ModifyCacheParameterGroupCommand)).toHaveLength(0);
  });

  it('sends nothing when no Properties op is present', async () => {
    stubRead({ timeout: '300' });
    await SDK_WRITERS['AWS::ElastiCache::ParameterGroup'](ctx({ physicalId: PGN }), [
      { op: 'add', path: '/Description', value: 'x', human: 'x' },
    ]);
    expect(elasticache.commandCalls(ModifyCacheParameterGroupCommand)).toHaveLength(0);
    expect(elasticache.commandCalls(ResetCacheParameterGroupCommand)).toHaveLength(0);
  });
});

describe('MemoryDB ParameterGroup writer (SDK_SUPPLEMENTS reader; Update/Reset)', () => {
  const PGN = 'cdkrd-memorydb-params';
  // No SDK_OVERRIDES reader for this type (it is a supplement), so desiredModel applies the ops to
  // an empty base — the desired values come from each op's `value`, no read stub needed.

  it('a declared param (incl. one the provider never applied) -> UpdateParameterGroup', async () => {
    memorydb.on(UpdateMemoryDbParameterGroupCommand).resolves({});
    await SDK_WRITERS['AWS::MemoryDB::ParameterGroup'](ctx({ physicalId: PGN }), [
      {
        op: 'add',
        path: '/Parameters/maxmemory-policy',
        value: 'allkeys-lru',
        human: 'Parameters.maxmemory-policy -> deployed-template value',
      },
    ]);
    const update = memorydb.commandCalls(UpdateMemoryDbParameterGroupCommand);
    expect(update).toHaveLength(1);
    expect(update[0]!.args[0].input).toEqual({
      ParameterGroupName: PGN,
      ParameterNameValues: [{ ParameterName: 'maxmemory-policy', ParameterValue: 'allkeys-lru' }],
    });
    expect(memorydb.commandCalls(ResetMemoryDbParameterGroupCommand)).toHaveLength(0);
  });

  it('an undeclared added param -> ResetParameterGroup with bare ParameterNames (no update)', async () => {
    memorydb.on(ResetMemoryDbParameterGroupCommand).resolves({});
    await SDK_WRITERS['AWS::MemoryDB::ParameterGroup'](ctx({ physicalId: PGN }), [
      {
        op: 'remove',
        path: '/Parameters/maxmemory-samples',
        human: 'Parameters.maxmemory-samples -> remove (undeclared, not in baseline)',
      },
    ]);
    const reset = memorydb.commandCalls(ResetMemoryDbParameterGroupCommand);
    expect(reset).toHaveLength(1);
    expect(reset[0]!.args[0].input).toEqual({
      ParameterGroupName: PGN,
      AllParameters: false,
      ParameterNames: ['maxmemory-samples'],
    });
    expect(memorydb.commandCalls(UpdateMemoryDbParameterGroupCommand)).toHaveLength(0);
  });

  it('sends nothing when no Parameters op is present', async () => {
    await SDK_WRITERS['AWS::MemoryDB::ParameterGroup'](ctx({ physicalId: PGN }), [
      { op: 'add', path: '/Description', value: 'x', human: 'x' },
    ]);
    expect(memorydb.commandCalls(UpdateMemoryDbParameterGroupCommand)).toHaveLength(0);
    expect(memorydb.commandCalls(ResetMemoryDbParameterGroupCommand)).toHaveLength(0);
  });
});

describe('EC2 ClientVpnEndpoint writer (NON_PROVISIONABLE; ModifyClientVpnEndpoint, issue #552)', () => {
  const CVID = 'cvpn-endpoint-0123456789abcdef0';
  const stubRead = (over: Record<string, unknown> = {}): void => {
    ec2.on(DescribeClientVpnEndpointsCommand).resolves({
      ClientVpnEndpoints: [
        {
          ClientVpnEndpointId: CVID,
          Description: 'drifted',
          SplitTunnel: true,
          VpnPort: 443,
          TransportProtocol: 'udp',
          VpcId: 'vpc-abc',
          ...over,
        },
      ],
    } as never);
  };

  it('reverts scalar props (Description/SplitTunnel) via ModifyClientVpnEndpoint, drifted only', async () => {
    stubRead();
    ec2.on(ModifyClientVpnEndpointCommand).resolves({});
    await SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
      { op: 'add', path: '/Description', value: 'intended', human: 'Description -> value' },
    ]);
    const calls = ec2.commandCalls(ModifyClientVpnEndpointCommand);
    expect(calls).toHaveLength(1);
    // the reader read Description as 'drifted', revert op sets it to 'intended'
    expect(calls[0]!.args[0].input).toEqual({
      ClientVpnEndpointId: CVID,
      Description: 'intended',
    });
  });

  it('reshapes DnsServers (string[] read -> {CustomDnsServers,Enabled} modify)', async () => {
    stubRead({ DnsServers: ['10.0.0.2'] });
    ec2.on(ModifyClientVpnEndpointCommand).resolves({});
    await SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
      { op: 'add', path: '/DnsServers', value: ['10.0.0.2'], human: 'DnsServers -> value' },
    ]);
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)[0]!.args[0].input).toEqual({
      ClientVpnEndpointId: CVID,
      DnsServers: { CustomDnsServers: ['10.0.0.2'], Enabled: true },
    });
  });

  it('clears DnsServers when the revert removes them (Enabled:false)', async () => {
    stubRead({ DnsServers: undefined });
    ec2.on(ModifyClientVpnEndpointCommand).resolves({});
    await SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
      { op: 'remove', path: '/DnsServers', human: 'DnsServers -> (none)' },
    ]);
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)[0]!.args[0].input).toEqual({
      ClientVpnEndpointId: CVID,
      DnsServers: { Enabled: false },
    });
  });

  it('sends SecurityGroupIds together with VpcId (API requires the pair)', async () => {
    stubRead({ SecurityGroupIds: ['sg-111'] });
    ec2.on(ModifyClientVpnEndpointCommand).resolves({});
    await SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
      {
        op: 'add',
        path: '/SecurityGroupIds',
        value: ['sg-111'],
        human: 'SecurityGroupIds -> value',
      },
    ]);
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)[0]!.args[0].input).toEqual({
      ClientVpnEndpointId: CVID,
      SecurityGroupIds: ['sg-111'],
      VpcId: 'vpc-abc',
    });
  });

  it('clears OOB-added scalar props on a remove (Description="", SplitTunnel/DisconnectOnSessionTimeout=false), not a silent drop (#984)', async () => {
    stubRead({ Description: 'oob', SplitTunnel: true, DisconnectOnSessionTimeout: true });
    ec2.on(ModifyClientVpnEndpointCommand).resolves({});
    await SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
      { op: 'remove', path: '/Description', human: 'Description -> (none)' },
      { op: 'remove', path: '/SplitTunnel', human: 'SplitTunnel -> (none)' },
      {
        op: 'remove',
        path: '/DisconnectOnSessionTimeout',
        human: 'DisconnectOnSessionTimeout -> (none)',
      },
    ]);
    // omitting these from a selective ModifyClientVpnEndpoint would keep the live values — the
    // revert must send explicit clears so they actually converge
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)[0]!.args[0].input).toEqual({
      ClientVpnEndpointId: CVID,
      Description: '',
      SplitTunnel: false,
      DisconnectOnSessionTimeout: false,
    });
  });

  it('bars a VpnPort remove honestly (numeric unset not expressible, #984)', async () => {
    stubRead();
    await expect(
      SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
        { op: 'remove', path: '/VpnPort', human: 'VpnPort -> (none)' },
      ])
    ).rejects.toThrow(/VpnPort cannot be cleared/);
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)).toHaveLength(0);
  });

  it('bars a SecurityGroupIds remove honestly (cannot revert to no SG, #984)', async () => {
    stubRead({ SecurityGroupIds: ['sg-111'] });
    await expect(
      SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
        { op: 'remove', path: '/SecurityGroupIds', human: 'SecurityGroupIds -> (none)' },
      ])
    ).rejects.toThrow(/SecurityGroupIds cannot be cleared/);
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)).toHaveLength(0);
  });

  it('throws when the endpoint id is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: '', declared: {} }), [
        { op: 'add', path: '/Description', value: 'x', human: 'x' },
      ])
    ).rejects.toThrow(/endpoint id/);
  });

  it('applies the convergeable op(s) BEFORE barring an un-expressible sibling clear — no batch abort (#1102)', async () => {
    // A VpnPort set-default (#912, expressible) alongside a SessionTimeoutHours remove
    // (un-expressible). Previously the un-expressible clear THREW inline and aborted the whole
    // ModifyClientVpnEndpoint call, silently dropping the convergeable VpnPort revert.
    stubRead({ VpnPort: 1194, SessionTimeoutHours: 99 });
    ec2.on(ModifyClientVpnEndpointCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
        { op: 'add', path: '/VpnPort', value: 443, human: 'VpnPort -> 443' },
        { op: 'remove', path: '/SessionTimeoutHours', human: 'SessionTimeoutHours -> (none)' },
      ])
    ).rejects.toThrow(/SessionTimeoutHours cannot be cleared/);
    // the VpnPort set-default was STILL sent (isolated from the un-expressible sibling)
    const calls = ec2.commandCalls(ModifyClientVpnEndpointCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({ ClientVpnEndpointId: CVID, VpnPort: 443 });
  });

  it('bars a SessionTimeoutHours remove honestly when it is the ONLY op (nothing to send, #1102)', async () => {
    stubRead({ SessionTimeoutHours: 99 });
    await expect(
      SDK_WRITERS['AWS::EC2::ClientVpnEndpoint'](ctx({ physicalId: CVID }), [
        { op: 'remove', path: '/SessionTimeoutHours', human: 'SessionTimeoutHours -> (none)' },
      ])
    ).rejects.toThrow(/SessionTimeoutHours cannot be cleared/);
    expect(ec2.commandCalls(ModifyClientVpnEndpointCommand)).toHaveLength(0);
  });
});

describe('ServiceDiscovery HttpNamespace writer (CC read+write gap)', () => {
  const NSID = 'ns-abc';
  const descOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/Description',
    value,
    human: 'Description -> deployed-template value',
  });
  it('reverts Description via UpdateHttpNamespace, keyed by the namespace physical id', async () => {
    // reader (GetNamespace) returns the DRIFTED live value; the revert op carries the desired one.
    serviceDiscovery
      .on(GetNamespaceCommand)
      .resolves({ Namespace: { Name: 'shop', Description: 'DRIFTED' } });
    serviceDiscovery.on(UpdateHttpNamespaceCommand).resolves({ OperationId: 'op-1' });

    await SDK_WRITERS['AWS::ServiceDiscovery::HttpNamespace'](ctx({ physicalId: NSID }), [
      descOp('the desired description'),
    ]);

    const calls = serviceDiscovery.commandCalls(UpdateHttpNamespaceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      Id: NSID,
      Namespace: { Description: 'the desired description' },
    });
  });

  it('throws when the namespace id is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::ServiceDiscovery::HttpNamespace'](ctx({ physicalId: '' }), [descOp('x')])
    ).rejects.toThrow(/namespace id/);
  });
});

describe('ServiceDiscovery Service writer (#1573)', () => {
  const SVCID = 'srv-larvapfwzod2rbjj';
  // The GetService mock mirrors the REAL live echo shape (harvested corpus case
  // AWS__ServiceDiscovery__Service.NsSvcFBBB2FA7 — a private-DNS-namespace L2 service),
  // not the declared template: Type DNS_HTTP + DnsConfig carrying NamespaceId /
  // RoutingPolicy echoes alongside the DnsRecords.
  const liveService = (over: Record<string, unknown> = {}) => ({
    Service: {
      Id: SVCID,
      Name: 'hunt-svc',
      NamespaceId: 'ns-xd4yucfbkz52j6v2',
      Type: 'DNS_HTTP',
      DnsConfig: {
        NamespaceId: 'ns-xd4yucfbkz52j6v2',
        RoutingPolicy: 'MULTIVALUE',
        DnsRecords: [{ Type: 'A', TTL: 300 }], // 300 = the DRIFTED live value
      },
      ...over,
    },
  });
  const ttlOp: PatchOp = {
    op: 'add',
    path: '/DnsConfig/DnsRecords/0/TTL',
    value: 60,
    prior: 300,
    human: 'DnsConfig.DnsRecords.0.TTL -> deployed-template value',
  };

  it('reverts a drifted DnsRecords TTL via UpdateService, sending the FULL desired DnsConfig', async () => {
    serviceDiscovery.on(GetServiceCommand).resolves(liveService() as never);
    serviceDiscovery.on(SdUpdateServiceCommand).resolves({ OperationId: 'op-1' });

    await SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: SVCID }), [ttlOp]);

    const calls = serviceDiscovery.commandCalls(SdUpdateServiceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      Id: SVCID,
      Service: { DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] } },
    });
  });

  it('carries the existing Description alongside the DnsConfig (UpdateService REPLACE-safety)', async () => {
    serviceDiscovery
      .on(GetServiceCommand)
      .resolves(liveService({ Description: 'keep me' }) as never);
    serviceDiscovery.on(SdUpdateServiceCommand).resolves({ OperationId: 'op-1' });

    await SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: SVCID }), [ttlOp]);

    // An UpdateService request that OMITS an existing Description would DELETE it — the
    // writer must always send the full mutable trio, not just the drifted field.
    expect(serviceDiscovery.commandCalls(SdUpdateServiceCommand)[0]!.args[0].input).toEqual({
      Id: SVCID,
      Service: {
        Description: 'keep me',
        DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 60 }] },
      },
    });
  });

  it('converges a removed out-of-band Description by OMITTING it from the request', async () => {
    serviceDiscovery.on(GetServiceCommand).resolves(liveService({ Description: 'ROGUE' }) as never);
    serviceDiscovery.on(SdUpdateServiceCommand).resolves({ OperationId: 'op-1' });

    await SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: SVCID }), [
      { op: 'remove', path: '/Description', human: 'Description -> unset' },
    ]);

    // UpdateService deletes an omitted existing configuration — exactly the desired end state.
    expect(serviceDiscovery.commandCalls(SdUpdateServiceCommand)[0]!.args[0].input).toEqual({
      Id: SVCID,
      Service: { DnsConfig: { DnsRecords: [{ Type: 'A', TTL: 300 }] } },
    });
  });

  it('bars a service in an API-only (HTTP) namespace up front — UpdateService cannot modify it', async () => {
    serviceDiscovery
      .on(GetServiceCommand)
      .resolves({ Service: { Id: SVCID, Name: 'api-svc', Type: 'HTTP' } } as never);

    await expect(
      SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: SVCID }), [
        { op: 'add', path: '/Description', value: 'x', human: 'Description' },
      ])
    ).rejects.toThrow(/API-only/);
    expect(serviceDiscovery.commandCalls(SdUpdateServiceCommand)).toHaveLength(0);
  });

  it('throws naming an inexpressible op (DnsConfig.RoutingPolicy) without a doomed call', async () => {
    serviceDiscovery.on(GetServiceCommand).resolves(liveService() as never);

    await expect(
      SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: SVCID }), [
        { op: 'add', path: '/DnsConfig/RoutingPolicy', value: 'WEIGHTED', human: 'RoutingPolicy' },
      ])
    ).rejects.toThrow(/DnsConfig\/RoutingPolicy/);
    expect(serviceDiscovery.commandCalls(SdUpdateServiceCommand)).toHaveLength(0);
  });

  it('applies the expressible sibling op BEFORE throwing on the inexpressible one (#804)', async () => {
    serviceDiscovery.on(GetServiceCommand).resolves(liveService() as never);
    serviceDiscovery.on(SdUpdateServiceCommand).resolves({ OperationId: 'op-1' });

    await expect(
      SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: SVCID }), [
        ttlOp,
        { op: 'add', path: '/NamespaceId', value: 'ns-other', human: 'NamespaceId' },
      ])
    ).rejects.toThrow(/NamespaceId/);
    // The convergeable TTL revert still went out.
    expect(serviceDiscovery.commandCalls(SdUpdateServiceCommand)).toHaveLength(1);
  });

  it('throws when the service id is unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::ServiceDiscovery::Service'](ctx({ physicalId: '' }), [ttlOp])
    ).rejects.toThrow(/service id/);
  });
});

describe('IAM ManagedPolicy writer', () => {
  it('creates a new default version carrying the reverted document', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam
      .on(ListPolicyVersionsCommand)
      .resolves({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [addOp(DESIRED)]);

    const created = iam.commandCalls(CreatePolicyVersionCommand);
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      SetAsDefault: true,
      PolicyDocument: JSON.stringify(DESIRED),
    });
    expect(iam.commandCalls(DeletePolicyVersionCommand)).toHaveLength(0);
  });

  it('prunes the oldest NON-default version when 5 already exist before creating', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    const d = (s: string) => new Date(s);
    iam.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v5', IsDefaultVersion: true, CreateDate: d('2020-05-01') },
        { VersionId: 'v2', IsDefaultVersion: false, CreateDate: d('2020-02-01') },
        { VersionId: 'v1', IsDefaultVersion: false, CreateDate: d('2020-01-01') }, // oldest non-default
        { VersionId: 'v4', IsDefaultVersion: false, CreateDate: d('2020-04-01') },
        { VersionId: 'v3', IsDefaultVersion: false, CreateDate: d('2020-03-01') },
      ],
    });
    iam.on(DeletePolicyVersionCommand).resolves({});
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [addOp(DESIRED)]);

    const deleted = iam.commandCalls(DeletePolicyVersionCommand);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.args[0].input).toMatchObject({ PolicyArn: ARN, VersionId: 'v1' });
    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(1);
  });

  it('falls back to ctx.declared.ManagedPolicyArn when physicalId is not an arn', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](
      ctx({ physicalId: 'not-an-arn', declared: { ManagedPolicyArn: ARN } }),
      [addOp(DESIRED)]
    );

    expect(iam.commandCalls(CreatePolicyVersionCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
    });
  });

  it('throws when no managed policy arn can be resolved', async () => {
    await expect(
      SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx({ physicalId: 'x', declared: {} }), [
        addOp(DESIRED),
      ])
    ).rejects.toThrow(/managed policy arn/);
  });

  it('a statement-indexed op lands on the canonical statement, not the raw one (WAVE21)', async () => {
    // The live doc's RAW statement order differs from the canonical (sorted) order
    // classify compared. A finding at canonical Statement[1] (zzz:Write) must revert
    // THAT statement — not raw Statement[1] (aaa:Read). Before the fix the op corrupted
    // aaa:Read and left zzz:Write's HACKED resource unreverted.
    stubReader({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'zzz:Write', Resource: 'HACKED' }, // raw[0], canonical[1]
        { Effect: 'Allow', Action: 'aaa:Read', Resource: 'r2' }, // raw[1], canonical[0]
      ],
    });
    iam
      .on(ListPolicyVersionsCommand)
      .resolves({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    // revert the drifted zzz:Write Resource (canonical index 1) back to the declared value
    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [
      {
        op: 'add',
        path: '/PolicyDocument/Statement/1/Resource',
        value: ['r1'],
        human: 'PolicyDocument.Statement.1.Resource -> deployed-template value',
      },
    ]);

    const created = iam.commandCalls(CreatePolicyVersionCommand);
    expect(created).toHaveLength(1);
    const written = JSON.parse(created[0]!.args[0].input.PolicyDocument as string) as {
      Statement: { Action: string[]; Resource: unknown }[];
    };
    const byAction = (a: string) => written.Statement.find((s) => s.Action.includes(a));
    // the RIGHT statement was reverted...
    expect(byAction('zzz:Write')!.Resource).toEqual(['r1']);
    // ...and the unrelated statement was NOT corrupted (stayed r2)
    expect(byAction('aaa:Read')!.Resource).toEqual(['r2']);
  });

  // A declared attachment detached out of band is re-attached BY MEMBER (the detach
  // finding carries the member on attributeKey), never by rewriting the whole list.
  const detachOp = (prop: string, member: string): PatchOp => ({
    op: 'add',
    path: `/${prop}`,
    value: member,
    attributeKey: member,
    human: `${prop}[${member}] -> deployed-template value`,
  });

  it('re-attaches a detached Role/User/Group by member, not by rewriting the list', async () => {
    iam.on(AttachRolePolicyCommand).resolves({});
    iam.on(AttachUserPolicyCommand).resolves({});
    iam.on(AttachGroupPolicyCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [
      detachOp('Roles', 'RoleA'),
      detachOp('Users', 'UserA'),
      detachOp('Groups', 'GroupA'),
    ]);

    expect(iam.commandCalls(AttachRolePolicyCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      RoleName: 'RoleA',
    });
    expect(iam.commandCalls(AttachUserPolicyCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      UserName: 'UserA',
    });
    expect(iam.commandCalls(AttachGroupPolicyCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      GroupName: 'GroupA',
    });
  });

  it('a detach-only revert does NOT burn a policy version (no CreatePolicyVersion)', async () => {
    iam.on(AttachRolePolicyCommand).resolves({});
    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [detachOp('Roles', 'RoleA')]);
    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(0);
    expect(iam.commandCalls(ListPolicyVersionsCommand)).toHaveLength(0);
  });

  it('a combined document + detach revert does both (version + attach)', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam
      .on(ListPolicyVersionsCommand)
      .resolves({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    iam.on(CreatePolicyVersionCommand).resolves({});
    iam.on(AttachRolePolicyCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [
      addOp(DESIRED),
      detachOp('Roles', 'RoleA'),
    ]);

    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(1);
    expect(iam.commandCalls(AttachRolePolicyCommand)).toHaveLength(1);
  });

  // An unexpected (live-only) attachment removed via --remove-unrecorded arrives as a
  // REMOVE op on the nested path `Roles[member]` — detach that member by parsing the path.
  const removeMemberOp = (prop: string, member: string): PatchOp => ({
    op: 'remove',
    path: `/${prop}[${member}]`,
    prior: member,
    human: `${prop}[${member}] -> remove (undeclared, not in baseline)`,
  });

  it('detaches an unexpected member from a `remove` op on the nested Prop[member] path', async () => {
    iam.on(DetachRolePolicyCommand).resolves({});
    iam.on(DetachUserPolicyCommand).resolves({});
    iam.on(DetachGroupPolicyCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [
      removeMemberOp('Roles', 'RoleX'),
      removeMemberOp('Users', 'UserX'),
      removeMemberOp('Groups', 'GroupX'),
    ]);

    expect(iam.commandCalls(DetachRolePolicyCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      RoleName: 'RoleX',
    });
    expect(iam.commandCalls(DetachUserPolicyCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      UserName: 'UserX',
    });
    expect(iam.commandCalls(DetachGroupPolicyCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      GroupName: 'GroupX',
    });
    // never re-attaches, and a detach-only revert burns no policy version
    expect(iam.commandCalls(AttachRolePolicyCommand)).toHaveLength(0);
    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(0);
  });
});

describe('IAM Role inline Policies prop-scoped writer', () => {
  const DOC = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
  };
  const writer = () => resolveSdkWriter('AWS::IAM::Role', [removePoliciesOp([])])!;
  const removePoliciesOp = (prior: unknown): PatchOp => ({
    op: 'remove',
    path: '/Policies',
    prior,
    human: 'Policies -> remove',
  });
  const addPoliciesOp = (value: unknown, prior: unknown): PatchOp => ({
    op: 'add',
    path: '/Policies',
    value,
    prior,
    human: 'Policies -> baseline value',
  });
  const roleCtx = ctx({ physicalId: 'my-role' });

  it('resolveSdkWriter finds the prop-scoped writer from the op pointer', () => {
    expect(resolveSdkWriter('AWS::IAM::Role', [removePoliciesOp([])])).toBeDefined();
    expect(
      resolveSdkWriter('AWS::IAM::Role', [{ op: 'remove', path: '/Description', human: '' }])
    ).toBeUndefined();
    expect(resolveSdkWriter('AWS::S3::BucketPolicy', [])).toBe(
      SDK_WRITERS['AWS::S3::BucketPolicy']
    );
  });

  it('remove: deletes ONLY the rogue policies named in prior (sibling policies untouched)', async () => {
    iam.on(DeleteRolePolicyCommand).resolves({});
    const rogue = [
      { PolicyName: 'rogue-a', PolicyDocument: DOC },
      { PolicyName: 'rogue-b', PolicyDocument: DOC },
    ];
    await writer()(roleCtx, [removePoliciesOp(rogue)]);
    const dels = iam.commandCalls(DeleteRolePolicyCommand);
    expect(dels.map((c) => c.args[0].input)).toEqual([
      { RoleName: 'my-role', PolicyName: 'rogue-a' },
      { RoleName: 'my-role', PolicyName: 'rogue-b' },
    ]);
    expect(iam.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it('add (baseline restore): puts every desired entry and deletes prior entries not in desired', async () => {
    iam.on(DeleteRolePolicyCommand).resolves({});
    iam.on(PutRolePolicyCommand).resolves({});
    const baseline = [{ PolicyName: 'kept', PolicyDocument: DOC }];
    const prior = [
      { PolicyName: 'kept', PolicyDocument: { changed: true } },
      { PolicyName: 'extra', PolicyDocument: DOC },
    ];
    await writer()(roleCtx, [addPoliciesOp(baseline, prior)]);
    expect(iam.commandCalls(DeleteRolePolicyCommand).map((c) => c.args[0].input)).toEqual([
      { RoleName: 'my-role', PolicyName: 'extra' },
    ]);
    expect(iam.commandCalls(PutRolePolicyCommand).map((c) => c.args[0].input)).toEqual([
      { RoleName: 'my-role', PolicyName: 'kept', PolicyDocument: JSON.stringify(DOC) },
    ]);
  });

  it('rejects a non-top-level Policies pointer (deep paths belong to Cloud Control)', async () => {
    await expect(
      writer()(roleCtx, [{ op: 'remove', path: '/Policies/0', prior: [], human: '' }])
    ).rejects.toThrow('unsupported inline-policy revert path');
  });

  it('a missing prior on a remove op is a safe no-op (never a bulk wipe)', async () => {
    await writer()(roleCtx, [{ op: 'remove', path: '/Policies', human: '' }]);
    expect(iam.commandCalls(DeleteRolePolicyCommand)).toHaveLength(0);
  });
});

describe('ELB attribute-bag prop-scoped writers (R78)', () => {
  const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/abc';
  const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/y/def';
  const attrOp = (path: string, attributeKey: string, value: unknown): PatchOp => ({
    op: 'add',
    path,
    value,
    attributeKey,
    human: `${path}[${attributeKey}] -> deployed-template value`,
  });

  it('resolveSdkWriter routes the bag property to the ELB prop writer', () => {
    expect(
      resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
        attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', '120'),
      ])
    ).toBeDefined();
    expect(
      resolveSdkWriter('AWS::ElasticLoadBalancingV2::TargetGroup', [
        attrOp('/TargetGroupAttributes', 'deregistration_delay.timeout_seconds', '15'),
      ])
    ).toBeDefined();
  });

  it('LoadBalancer: sends ONLY the declared attributes (Key=Value) to ModifyLoadBalancerAttributes', async () => {
    elb.on(ModifyLoadBalancerAttributesCommand).resolves({});
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', '120'),
    ])!;
    await writer(ctx({ physicalId: LB_ARN }), [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', '120'),
      attrOp('/LoadBalancerAttributes', 'deletion_protection.enabled', 'false'),
    ]);
    const calls = elb.commandCalls(ModifyLoadBalancerAttributesCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      LoadBalancerArn: LB_ARN,
      Attributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '120' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
      ],
    });
  });

  it('LoadBalancer: a non-string desired value is stringified (ELB Values are strings)', async () => {
    elb.on(ModifyLoadBalancerAttributesCommand).resolves({});
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', 120),
    ])!;
    await writer(ctx({ physicalId: LB_ARN }), [
      attrOp('/LoadBalancerAttributes', 'idle_timeout.timeout_seconds', 120),
    ]);
    expect(
      elb.commandCalls(ModifyLoadBalancerAttributesCommand)[0].args[0].input.Attributes
    ).toEqual([{ Key: 'idle_timeout.timeout_seconds', Value: '120' }]);
  });

  it('TargetGroup: sends to ModifyTargetGroupAttributes with the TG arn', async () => {
    elb.on(ModifyTargetGroupAttributesCommand).resolves({});
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::TargetGroup', [
      attrOp('/TargetGroupAttributes', 'deregistration_delay.timeout_seconds', '15'),
    ])!;
    await writer(ctx({ physicalId: TG_ARN }), [
      attrOp('/TargetGroupAttributes', 'deregistration_delay.timeout_seconds', '15'),
    ]);
    expect(elb.commandCalls(ModifyTargetGroupAttributesCommand)[0].args[0].input).toEqual({
      TargetGroupArn: TG_ARN,
      Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }],
    });
  });

  it('no attribute-keyed ops -> no AWS call (never a blind write)', async () => {
    const writer = resolveSdkWriter('AWS::ElasticLoadBalancingV2::LoadBalancer', [
      attrOp('/LoadBalancerAttributes', 'x', '1'),
    ])!;
    await writer(ctx({ physicalId: LB_ARN }), [
      { op: 'add', path: '/LoadBalancerAttributes', value: '1', human: '' },
    ]);
    expect(elb.commandCalls(ModifyLoadBalancerAttributesCommand)).toHaveLength(0);
  });
});

describe('policy writers revert ALL attachment targets (not just the first)', () => {
  it('IAM Policy: the inline policy is put on EVERY role, user and group', async () => {
    iam.on(GetRolePolicyCommand).resolves({ PolicyDocument: '{}' }); // reader reads the first role
    iam.on(PutRolePolicyCommand).resolves({});
    iam.on(PutUserPolicyCommand).resolves({});
    iam.on(PutGroupPolicyCommand).resolves({});
    await SDK_WRITERS['AWS::IAM::Policy'](
      ctx({
        declared: {
          PolicyName: 'p',
          Roles: ['role-a', 'role-b'],
          Users: ['user-a'],
          Groups: ['group-a'],
        },
      }),
      [addOp(DESIRED)]
    );
    expect(iam.commandCalls(PutRolePolicyCommand).map((c) => c.args[0].input.RoleName)).toEqual([
      'role-a',
      'role-b',
    ]);
    expect(iam.commandCalls(PutUserPolicyCommand).map((c) => c.args[0].input.UserName)).toEqual([
      'user-a',
    ]);
    expect(iam.commandCalls(PutGroupPolicyCommand).map((c) => c.args[0].input.GroupName)).toEqual([
      'group-a',
    ]);
  });

  it('IAM Policy: no target throws', async () => {
    await expect(
      SDK_WRITERS['AWS::IAM::Policy'](ctx({ declared: { PolicyName: 'p' } }), [addOp(DESIRED)])
    ).rejects.toThrow('no role/user/group target');
  });

  it('SNS TopicPolicy: the policy is set on EVERY topic', async () => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: '{}' } });
    sns.on(SetTopicAttributesCommand).resolves({});
    await SDK_WRITERS['AWS::SNS::TopicPolicy'](
      ctx({ declared: { Topics: ['arn:aws:sns:us-east-1:1:t1', 'arn:aws:sns:us-east-1:1:t2'] } }),
      [addOp(DESIRED)]
    );
    expect(
      sns.commandCalls(SetTopicAttributesCommand).map((c) => c.args[0].input.TopicArn)
    ).toEqual(['arn:aws:sns:us-east-1:1:t1', 'arn:aws:sns:us-east-1:1:t2']);
  });

  it('SQS QueuePolicy: the policy is set on EVERY queue', async () => {
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: '{}' } });
    sqs.on(SetQueueAttributesCommand).resolves({});
    await SDK_WRITERS['AWS::SQS::QueuePolicy'](
      ctx({ declared: { Queues: ['https://sqs/q1', 'https://sqs/q2'] } }),
      [addOp(DESIRED)]
    );
    expect(
      sqs.commandCalls(SetQueueAttributesCommand).map((c) => c.args[0].input.QueueUrl)
    ).toEqual(['https://sqs/q1', 'https://sqs/q2']);
  });
});

describe('Logs LogGroup BearerTokenAuthenticationEnabled prop-scoped writer (CC UpdateResource fails on this property)', () => {
  const LG = '/aws/lambda/my-fn';
  const removeOp: PatchOp = {
    op: 'remove',
    path: '/BearerTokenAuthenticationEnabled',
    prior: true,
    human: 'BearerTokenAuthenticationEnabled -> remove (undeclared, not in baseline)',
  };
  const bearerAddOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/BearerTokenAuthenticationEnabled',
    value,
    human: 'BearerTokenAuthenticationEnabled -> deployed-template value',
  });

  it('resolveSdkWriter routes BearerTokenAuthenticationEnabled to the prop-scoped writer', () => {
    expect(resolveSdkWriter('AWS::Logs::LogGroup', [removeOp])).toBeDefined();
    // a deeper / other LogGroup path keeps going through Cloud Control (no SDK writer)
    expect(
      resolveSdkWriter('AWS::Logs::LogGroup', [
        { op: 'remove', path: '/RetentionInDays', human: '' },
      ])
    ).toBeUndefined();
  });

  it('a remove (undeclared, not in baseline) DISABLES bearer-token auth via PutBearerTokenAuthentication', async () => {
    logs.on(PutBearerTokenAuthenticationCommand).resolves({});
    const writer = resolveSdkWriter('AWS::Logs::LogGroup', [removeOp])!;
    await writer(ctx({ physicalId: LG }), [removeOp]);
    const calls = logs.commandCalls(PutBearerTokenAuthenticationCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      logGroupIdentifier: LG,
      bearerTokenAuthenticationEnabled: false,
    });
  });

  it('an add carries the desired boolean (declared / baseline restore)', async () => {
    logs.on(PutBearerTokenAuthenticationCommand).resolves({});
    const writer = resolveSdkWriter('AWS::Logs::LogGroup', [bearerAddOp(true)])!;
    await writer(ctx({ physicalId: LG }), [bearerAddOp(true)]);
    expect(logs.commandCalls(PutBearerTokenAuthenticationCommand)[0].args[0].input).toEqual({
      logGroupIdentifier: LG,
      bearerTokenAuthenticationEnabled: true,
    });
  });

  it('falls back to declared LogGroupName when the physical id is absent', async () => {
    logs.on(PutBearerTokenAuthenticationCommand).resolves({});
    const writer = resolveSdkWriter('AWS::Logs::LogGroup', [removeOp])!;
    await writer(ctx({ physicalId: '', declared: { LogGroupName: LG } }), [removeOp]);
    expect(
      logs.commandCalls(PutBearerTokenAuthenticationCommand)[0].args[0].input.logGroupIdentifier
    ).toBe(LG);
  });
});

describe('CloudWatch CompositeAlarm ActionsEnabled prop-scoped writer (#1619 — the CC handler ignores even an explicit write)', () => {
  const NAME = 'cdkrd-composite';
  const actionsRemoveOp: PatchOp = {
    op: 'remove',
    path: '/ActionsEnabled',
    prior: false,
    human: 'ActionsEnabled -> AWS default (undeclared, not in baseline)',
  };
  const actionsAddOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/ActionsEnabled',
    value,
    human: 'ActionsEnabled -> deployed-template value',
  });

  it('resolveSdkWriter routes ActionsEnabled to the prop-scoped writer, other paths stay CC', () => {
    expect(resolveSdkWriter('AWS::CloudWatch::CompositeAlarm', [actionsRemoveOp])).toBeDefined();
    expect(
      resolveSdkWriter('AWS::CloudWatch::CompositeAlarm', [
        { op: 'remove', path: '/AlarmDescription', human: '' },
      ])
    ).toBeUndefined();
  });

  it('a remove (undeclared, not in baseline) re-ENABLES actions via EnableAlarmActions', async () => {
    cloudwatch.on(EnableAlarmActionsCommand).resolves({});
    const writer = resolveSdkWriter('AWS::CloudWatch::CompositeAlarm', [actionsRemoveOp])!;
    await writer(ctx({ physicalId: NAME }), [actionsRemoveOp]);
    const calls = cloudwatch.commandCalls(EnableAlarmActionsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({ AlarmNames: [NAME] });
  });

  it('an add true (the REVERT_SET_DEFAULT_PATHS set-default) also routes to EnableAlarmActions', async () => {
    cloudwatch.on(EnableAlarmActionsCommand).resolves({});
    const writer = resolveSdkWriter('AWS::CloudWatch::CompositeAlarm', [actionsAddOp(true)])!;
    await writer(ctx({ physicalId: NAME }), [actionsAddOp(true)]);
    expect(cloudwatch.commandCalls(EnableAlarmActionsCommand)).toHaveLength(1);
  });

  it('an add false (declared / baseline restore of a disable) routes to DisableAlarmActions', async () => {
    cloudwatch.on(DisableAlarmActionsCommand).resolves({});
    const writer = resolveSdkWriter('AWS::CloudWatch::CompositeAlarm', [actionsAddOp(false)])!;
    await writer(ctx({ physicalId: NAME }), [actionsAddOp(false)]);
    expect(cloudwatch.commandCalls(DisableAlarmActionsCommand)[0].args[0].input).toEqual({
      AlarmNames: [NAME],
    });
  });
});

describe('writeConfigRuleInputParameters (AWS::Config::ConfigRule, JSON-string property)', () => {
  const inputParamsOp = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/InputParameters',
    value,
    human: 'InputParameters -> deployed-template value',
  });

  it('re-PUTs the rule with a COMPACT InputParameters JSON string (no spaces), preserving other fields', async () => {
    configService.on(DescribeConfigRulesCommand).resolves({
      ConfigRules: [
        {
          ConfigRuleName: 'cdkrd-access-keys-rotated',
          ConfigRuleArn: 'arn:aws:config:us-east-1:111122223333:config-rule/config-rule-x',
          ConfigRuleId: 'config-rule-x',
          ConfigRuleState: 'ACTIVE',
          Source: { Owner: 'AWS', SourceIdentifier: 'ACCESS_KEYS_ROTATED' },
          MaximumExecutionFrequency: 'TwentyFour_Hours',
          InputParameters: '{"maxAccessKeyAge":"365"}',
        },
      ],
    });
    configService.on(PutConfigRuleCommand).resolves({});
    const writer = resolveSdkWriter('AWS::Config::ConfigRule', [
      inputParamsOp({ maxAccessKeyAge: 90 }),
    ])!;
    await writer(ctx({ physicalId: 'cdkrd-access-keys-rotated' }), [
      inputParamsOp({ maxAccessKeyAge: 90 }),
    ]);
    const put = configService.commandCalls(PutConfigRuleCommand)[0].args[0].input.ConfigRule!;
    // compact JSON string with STRING-coerced param values — Config rejects both spaces
    // and a numeric value ("Blank spaces are not acceptable for input parameter")
    expect(put.InputParameters).toBe('{"maxAccessKeyAge":"90"}');
    expect(put.InputParameters).not.toContain(' ');
    // other rule fields preserved; read-only server fields dropped
    expect(put.Source).toEqual({ Owner: 'AWS', SourceIdentifier: 'ACCESS_KEYS_ROTATED' });
    expect(put.MaximumExecutionFrequency).toBe('TwentyFour_Hours');
    expect(put.ConfigRuleArn).toBeUndefined();
    expect(put.ConfigRuleId).toBeUndefined();
    expect(put.ConfigRuleState).toBeUndefined();
  });

  it('compacts a value that arrives as a whitespace-laden JSON string', async () => {
    configService.on(DescribeConfigRulesCommand).resolves({
      ConfigRules: [{ ConfigRuleName: 'r', Source: { Owner: 'AWS', SourceIdentifier: 'X' } }],
    });
    configService.on(PutConfigRuleCommand).resolves({});
    const writer = resolveSdkWriter('AWS::Config::ConfigRule', [inputParamsOp('{ "a": "1" }')])!;
    await writer(ctx({ physicalId: 'r' }), [inputParamsOp('{ "a": "1" }')]);
    expect(
      configService.commandCalls(PutConfigRuleCommand)[0].args[0].input.ConfigRule!.InputParameters
    ).toBe('{"a":"1"}');
  });

  it('bars a remove (clear) honestly — the clearing payload needs a live probe (#913)', async () => {
    const removeOp: PatchOp = {
      op: 'remove',
      path: '/InputParameters',
      human: 'InputParameters -> (none)',
    };
    const writer = resolveSdkWriter('AWS::Config::ConfigRule', [removeOp])!;
    // the bar precedes DescribeConfigRules, so no silent PutConfigRule drop
    await expect(writer(ctx({ physicalId: 'r' }), [removeOp])).rejects.toThrow(
      /InputParameters cannot be cleared/
    );
    expect(configService.commandCalls(PutConfigRuleCommand)).toHaveLength(0);
  });

  it('throws when the rule cannot be found (no silent no-op)', async () => {
    configService.on(DescribeConfigRulesCommand).resolves({ ConfigRules: [] });
    const writer = resolveSdkWriter('AWS::Config::ConfigRule', [inputParamsOp({ a: 1 })])!;
    await expect(writer(ctx({ physicalId: 'missing' }), [inputParamsOp({ a: 1 })])).rejects.toThrow(
      /Config rule not found/
    );
  });
});

describe('writeMskConfiguration (AWS::MSK::Configuration ServerProperties, #508)', () => {
  const arn = 'arn:aws:kafka:us-east-1:111111111111:configuration/c/abc-1';
  const op = (value: unknown): PatchOp => ({
    op: 'add',
    path: '/ServerProperties',
    value,
    human: 'ServerProperties -> deployed-template value',
  });

  it('creates the next revision via UpdateConfiguration with the desired properties as bytes', async () => {
    kafka.on(UpdateConfigurationCommand).resolves({});
    const desired = 'auto.create.topics.enable=false\nlog.retention.hours=168\n';
    const writer = resolveSdkWriter('AWS::MSK::Configuration', [op(desired)])!;
    await writer(ctx({ physicalId: arn }), [op(desired)]);
    const input = kafka.commandCalls(UpdateConfigurationCommand)[0].args[0].input;
    expect(input.Arn).toBe(arn);
    expect(new TextDecoder().decode(input.ServerProperties as Uint8Array)).toBe(desired);
  });

  it('throws on an unexpected op (never a silent no-op)', async () => {
    const removeOp: PatchOp = { op: 'remove', path: '/ServerProperties', human: 'x' };
    const writer = resolveSdkWriter('AWS::MSK::Configuration', [removeOp])!;
    await expect(writer(ctx({ physicalId: arn }), [removeOp])).rejects.toThrow(/unexpected op/);
  });
});

describe('Cloud Control index-revert writer (array-element nested values)', () => {
  const ctx = (resourceType: string, physicalId: string, identifier?: string): OverrideCtx => ({
    physicalId,
    ...(identifier !== undefined && { identifier }),
    declared: {},
    region: 'us-east-1',
    accountId: '123456789012',
    resourceType,
  });

  it('re-points an identity bracket to the live-array INDEX and sends ONE UpdateResource', async () => {
    // live model: the rule of interest is at index 1 (Priority 100), NOT index 0.
    cloudcontrol.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: JSON.stringify({
          FirewallRules: [
            { Priority: 50, FirewallDomainRedirectionAction: 'INSPECT_REDIRECTION_DOMAIN' },
            { Priority: 100, FirewallDomainRedirectionAction: 'TRUST_REDIRECTION_DOMAIN' },
          ],
        }),
      },
    });
    cloudcontrol
      .on(UpdateResourceCommand)
      .resolves({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS' } });
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/FirewallRules[100]/FirewallDomainRedirectionAction',
        value: 'INSPECT_REDIRECTION_DOMAIN',
        human: 'x',
      },
    ];
    await resolveSdkWriter('AWS::Route53Resolver::FirewallRuleGroup', ops)!(
      ctx('AWS::Route53Resolver::FirewallRuleGroup', 'rslvr-frg-x'),
      ops
    );
    const calls = cloudcontrol.commandCalls(UpdateResourceCommand);
    expect(calls).toHaveLength(1);
    const patch = JSON.parse(calls[0]!.args[0].input.PatchDocument as string);
    // [100] (Priority) -> live index 1
    expect(patch).toEqual([
      {
        op: 'add',
        path: '/FirewallRules/1/FirewallDomainRedirectionAction',
        value: 'INSPECT_REDIRECTION_DOMAIN',
      },
    ]);
  });

  it('resolves a non-standard-keyed nested array (Backup BackupPlanRule by RuleName)', async () => {
    cloudcontrol.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: JSON.stringify({
          BackupPlan: { BackupPlanRule: [{ RuleName: 'Daily', CompletionWindowMinutes: 5000 }] },
        }),
      },
    });
    cloudcontrol
      .on(UpdateResourceCommand)
      .resolves({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS' } });
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/BackupPlan/BackupPlanRule[Daily]/CompletionWindowMinutes',
        value: 10080,
        human: 'x',
      },
    ];
    await resolveSdkWriter('AWS::Backup::BackupPlan', ops)!(
      ctx('AWS::Backup::BackupPlan', 'plan|abc'),
      ops
    );
    const patch = JSON.parse(
      cloudcontrol.commandCalls(UpdateResourceCommand)[0]!.args[0].input.PatchDocument as string
    );
    expect(patch).toEqual([
      { op: 'add', path: '/BackupPlan/BackupPlanRule/0/CompletionWindowMinutes', value: 10080 },
    ]);
  });

  it('resolves a Secret ReplicaRegions element (keyed by Region) to its live index', async () => {
    // live reorders the replicas: us-west-2 is at index 1.
    cloudcontrol.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: JSON.stringify({
          ReplicaRegions: [
            { Region: 'eu-west-1', KmsKeyId: 'alias/aws/secretsmanager' },
            { Region: 'us-west-2', KmsKeyId: 'arn:aws:kms:us-west-2:111111111111:key/abcd' },
          ],
        }),
      },
    });
    cloudcontrol
      .on(UpdateResourceCommand)
      .resolves({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS' } });
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/ReplicaRegions[us-west-2]/KmsKeyId',
        value: 'alias/aws/secretsmanager',
        human: 'x',
      },
    ];
    await resolveSdkWriter('AWS::SecretsManager::Secret', ops)!(
      ctx('AWS::SecretsManager::Secret', 'arn:secret'),
      ops
    );
    const patch = JSON.parse(
      cloudcontrol.commandCalls(UpdateResourceCommand)[0]!.args[0].input.PatchDocument as string
    );
    expect(patch).toEqual([
      { op: 'add', path: '/ReplicaRegions/1/KmsKeyId', value: 'alias/aws/secretsmanager' },
    ]);
  });

  it('resolves an ApiGateway Stage MethodSettings element (keyed by HttpMethod) to its live index', async () => {
    cloudcontrol.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: JSON.stringify({
          MethodSettings: [
            { HttpMethod: 'GET', ResourcePath: '/foo', CacheTtlInSeconds: 300 },
            { HttpMethod: '*', ResourcePath: '/*', CacheTtlInSeconds: 600 },
          ],
        }),
      },
    });
    cloudcontrol
      .on(UpdateResourceCommand)
      .resolves({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS' } });
    const ops: PatchOp[] = [
      { op: 'add', path: '/MethodSettings[*]/CacheTtlInSeconds', value: 300, human: 'x' },
    ];
    // AWS::ApiGateway::Stage is a COMPOSITE-identifier type (RestApiId|StageName): the writer
    // MUST address it by the resolved identifier, not the bare physical id (`prod`), or CC
    // rejects "Identifier prod is not valid". The stack-actions sdk path resolves this via
    // CC_IDENTIFIER_ADAPTERS and sets ctx.identifier — observed live (PR for #419).
    await resolveSdkWriter('AWS::ApiGateway::Stage', ops)!(
      ctx('AWS::ApiGateway::Stage', 'prod', 'abc123|prod'),
      ops
    );
    expect(cloudcontrol.commandCalls(GetResourceCommand)[0]!.args[0].input.Identifier).toBe(
      'abc123|prod'
    );
    const update = cloudcontrol.commandCalls(UpdateResourceCommand)[0]!.args[0].input;
    expect(update.Identifier).toBe('abc123|prod');
    const patch = JSON.parse(update.PatchDocument as string);
    expect(patch).toEqual([{ op: 'add', path: '/MethodSettings/1/CacheTtlInSeconds', value: 300 }]);
  });

  it('throws (honest failure) when the identity cannot be located in the live array', async () => {
    cloudcontrol.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: JSON.stringify({ FirewallRules: [{ Priority: 50 }] }) },
    });
    const ops: PatchOp[] = [
      {
        op: 'add',
        path: '/FirewallRules[999]/FirewallDomainRedirectionAction',
        value: 'X',
        human: 'x',
      },
    ];
    await expect(
      resolveSdkWriter('AWS::Route53Resolver::FirewallRuleGroup', ops)!(
        ctx('AWS::Route53Resolver::FirewallRuleGroup', 'rg'),
        ops
      )
    ).rejects.toThrow(/cannot locate/);
  });

  // #1065 — the writer must POLL the returned ProgressEvent to a terminal state before
  // returning success; an async handler FAILURE after CC accepts the request must surface
  // (carrying its StatusMessage) instead of a false `reverted:`.
  const okOps: PatchOp[] = [
    {
      op: 'add',
      path: '/BackupPlan/BackupPlanRule[Daily]/CompletionWindowMinutes',
      value: 10080,
      human: 'x',
    },
  ];
  const mockGetResource = (): void => {
    cloudcontrol.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Properties: JSON.stringify({
          BackupPlan: { BackupPlanRule: [{ RuleName: 'Daily', CompletionWindowMinutes: 5000 }] },
        }),
      },
    });
  };

  it('surfaces an async FAILED ProgressEvent (with its StatusMessage) instead of a false success', async () => {
    mockGetResource();
    // CC accepts the UpdateResource, but the async handler FAILS — the reason lives only on
    // the FAILED event's StatusMessage. The writer must throw it, not resolve.
    cloudcontrol.on(UpdateResourceCommand).resolves({
      ProgressEvent: {
        RequestToken: 'tok-1',
        OperationStatus: 'FAILED',
        ErrorCode: 'GeneralServiceException',
        StatusMessage: 'Backup plan version limit exceeded',
      },
    });
    await expect(
      resolveSdkWriter('AWS::Backup::BackupPlan', okOps)!(
        ctx('AWS::Backup::BackupPlan', 'plan|abc'),
        okOps
      )
    ).rejects.toThrow(/Backup plan version limit exceeded/);
    // No poll needed — the accept event was already terminal.
    expect(cloudcontrol.commandCalls(GetResourceRequestStatusCommand)).toHaveLength(0);
  });

  it('resolves normally when the ProgressEvent reaches SUCCESS', async () => {
    mockGetResource();
    cloudcontrol
      .on(UpdateResourceCommand)
      .resolves({ ProgressEvent: { RequestToken: 'tok-2', OperationStatus: 'SUCCESS' } });
    await expect(
      resolveSdkWriter('AWS::Backup::BackupPlan', okOps)!(
        ctx('AWS::Backup::BackupPlan', 'plan|abc'),
        okOps
      )
    ).resolves.toBeUndefined();
  });

  it('throws "no request token" when CC accepts without a RequestToken (cannot confirm)', async () => {
    mockGetResource();
    // A malformed accept with no token — the operation cannot be polled, so success is
    // unconfirmable: throw rather than claim a false `reverted:`.
    cloudcontrol
      .on(UpdateResourceCommand)
      .resolves({ ProgressEvent: { OperationStatus: 'IN_PROGRESS' } });
    await expect(
      resolveSdkWriter('AWS::Backup::BackupPlan', okOps)!(
        ctx('AWS::Backup::BackupPlan', 'plan|abc'),
        okOps
      )
    ).rejects.toThrow(/no request token/);
  });
});

// #1065 — the poll loop itself: an IN_PROGRESS accept is followed by GetResourceRequestStatus
// reads until a terminal state. Exercised directly with an injected sleep/clock so the 2s
// poll interval never waits real time.
describe('pollNestedToCompletion (Cloud Control ProgressEvent poll, #1065)', () => {
  const noSleep = async (): Promise<void> => {};

  it('polls IN_PROGRESS -> FAILED and throws with the StatusMessage', async () => {
    cloudcontrol.on(GetResourceRequestStatusCommand).resolvesOnce({
      ProgressEvent: {
        RequestToken: 'tok',
        OperationStatus: 'FAILED',
        StatusMessage: 'AccessDenied invoking backup:UpdateBackupPlan',
      },
    });
    await expect(
      pollNestedToCompletion(
        cloudcontrol as unknown as CloudControlClient,
        { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' },
        { sleep: noSleep }
      )
    ).rejects.toThrow(/AccessDenied invoking backup:UpdateBackupPlan/);
    expect(cloudcontrol.commandCalls(GetResourceRequestStatusCommand)).toHaveLength(1);
  });

  it('polls IN_PROGRESS -> SUCCESS and resolves', async () => {
    cloudcontrol
      .on(GetResourceRequestStatusCommand)
      .resolvesOnce({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS' } });
    await expect(
      pollNestedToCompletion(
        cloudcontrol as unknown as CloudControlClient,
        { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' },
        { sleep: noSleep }
      )
    ).resolves.toBeUndefined();
  });

  it('re-polls the SAME token on a TRANSIENT poll-read failure (does NOT re-send the mutation)', async () => {
    cloudcontrol
      .on(GetResourceRequestStatusCommand)
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .resolves({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS' } });
    await expect(
      pollNestedToCompletion(
        cloudcontrol as unknown as CloudControlClient,
        { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' },
        { sleep: noSleep }
      )
    ).resolves.toBeUndefined();
    // Two reads: the throttled one, then the SUCCESS. UpdateResource is NEVER re-sent here.
    expect(cloudcontrol.commandCalls(GetResourceRequestStatusCommand)).toHaveLength(2);
    expect(cloudcontrol.commandCalls(UpdateResourceCommand)).toHaveLength(0);
  });

  it('times out (throws) if the operation never reaches a terminal state', async () => {
    cloudcontrol
      .on(GetResourceRequestStatusCommand)
      .resolves({ ProgressEvent: { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' } });
    // Injected clock jumps past the 15-min deadline after the first poll wait.
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 16 * 60 * 1000;
      return v;
    };
    await expect(
      pollNestedToCompletion(
        cloudcontrol as unknown as CloudControlClient,
        { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' },
        { sleep: noSleep, now }
      )
    ).rejects.toThrow(/timed out/);
  });
});

describe('Lex BotLocales writer (revert-by-rebuild via lexv2-models Update* APIs, #553)', () => {
  const BOT = 'B1234567';
  const lexCtx = (declared: Record<string, unknown>): OverrideCtx =>
    ctx({ physicalId: BOT, declared, resourceType: 'AWS::Lex::Bot' });
  const utteranceOp: PatchOp = {
    op: 'add',
    path: '/BotLocales/0/Intents/0/SampleUtterances',
    value: [{ Utterance: 'declared utterance' }],
    human: 'BotLocales.0.Intents.0.SampleUtterances -> deployed-template value',
  };
  // One locale, one intent (OrderFlowers) with one declared utterance, no slots/slotTypes.
  const declared = {
    BotLocales: [
      {
        LocaleId: 'en_US',
        NluConfidenceThreshold: 0.4,
        Intents: [
          { Name: 'OrderFlowers', SampleUtterances: [{ Utterance: 'declared utterance' }] },
        ],
      },
    ],
  };
  const stubTree = (): void => {
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [
        { intentId: 'I1', intentName: 'OrderFlowers' },
        // the auto-created built-in FallbackIntent is present in live but not declared — ignored
        { intentId: 'IF', intentName: 'FallbackIntent' },
      ],
    });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [] });
    // live intent carries an un-projected setting (dialogCodeHook) that revert must PRESERVE
    lex.on(DescribeIntentCommand).resolves({
      intentId: 'I1',
      intentName: 'OrderFlowers',
      sampleUtterances: [{ utterance: 'OUT OF BAND EDIT' }],
      dialogCodeHook: { enabled: true },
    } as never);
    lex.on(DescribeBotLocaleCommand).resolves({
      localeId: 'en_US',
      nluIntentConfidenceThreshold: 0.4,
      botLocaleStatus: 'Built',
    } as never);
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
  };

  it('routes a BotLocales path to the Lex writer (SDK_NESTED_WRITERS)', () => {
    expect(
      SDK_NESTED_WRITERS['AWS::Lex::Bot']!.match('BotLocales[0].Intents[0].SampleUtterances')
    ).toBe(true);
    expect(SDK_NESTED_WRITERS['AWS::Lex::Bot']!.match('Name')).toBe(false);
    expect(resolveSdkWriter('AWS::Lex::Bot', [utteranceOp])).toBe(
      SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer
    );
  });

  it('reverts an utterance edit via UpdateIntent (preserving un-projected settings) + BuildBotLocale', async () => {
    stubTree();
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(declared), [utteranceOp]);
    const calls = lex.commandCalls(UpdateIntentCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    // the declared utterance is re-supplied (mapped CFn Utterance -> API utterance)
    expect(input.sampleUtterances).toEqual([{ utterance: 'declared utterance' }]);
    // read-modify-write: the un-projected dialogCodeHook from the live intent is preserved
    expect(input.dialogCodeHook).toEqual({ enabled: true });
    expect(input.botId).toBe(BOT);
    expect(input.botVersion).toBe('DRAFT');
    // the locale is rebuilt so the reverted model is consistent
    expect(lex.commandCalls(BuildBotLocaleCommand)).toHaveLength(1);
  });

  it('does NOT false-refuse when FallbackIntent IS declared (live-caught: symmetric built-in exclusion)', async () => {
    // The live scenario: the template declares both the user OrderFlowers intent AND the
    // auto-managed FallbackIntent; live has both. An earlier version filtered FallbackIntent from
    // the LIVE set only, so the sizes differed and it false-refused. Assert it reconciles and
    // skips re-writing the built-in fallback.
    stubTree();
    const withFallback = {
      BotLocales: [
        {
          LocaleId: 'en_US',
          Intents: [
            { Name: 'OrderFlowers', SampleUtterances: [{ Utterance: 'declared utterance' }] },
            { Name: 'FallbackIntent', ParentIntentSignature: 'AMAZON.FallbackIntent' },
          ],
        },
      ],
    };
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(withFallback), [utteranceOp]);
    const calls = lex.commandCalls(UpdateIntentCommand);
    // only the USER intent is updated — the built-in FallbackIntent is skipped
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.intentName).toBe('OrderFlowers');
  });

  it('CREATES a declared intent missing from live (out-of-band delete) then updates it (#564)', async () => {
    // live has ONLY OrderFlowers; declared has OrderFlowers + AddOns → the declared AddOns intent
    // was deleted out of band → recreate it, then converge both via UpdateIntent.
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [{ intentId: 'I1', intentName: 'OrderFlowers' }],
    });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [] });
    lex.on(CreateIntentCommand).resolves({ intentId: 'I2', intentName: 'AddOns' });
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    const twoIntents = {
      BotLocales: [
        {
          LocaleId: 'en_US',
          Intents: [
            { Name: 'OrderFlowers', SampleUtterances: [{ Utterance: 'order' }] },
            { Name: 'AddOns', SampleUtterances: [{ Utterance: 'add ons' }] },
          ],
        },
      ],
    };
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(twoIntents), [utteranceOp]);
    const created = lex.commandCalls(CreateIntentCommand);
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0].input.intentName).toBe('AddOns');
    // the declared utterances are supplied on create (mapped CFn Utterance -> API utterance)
    expect(created[0]!.args[0].input.sampleUtterances).toEqual([{ utterance: 'add ons' }]);
    // both intents (the pre-existing OrderFlowers and the just-created AddOns) are then converged
    expect(lex.commandCalls(UpdateIntentCommand)).toHaveLength(2);
    // no intent was deleted, and the locale is rebuilt once
    expect(lex.commandCalls(DeleteIntentCommand)).toHaveLength(0);
    expect(lex.commandCalls(BuildBotLocaleCommand)).toHaveLength(1);
  });

  it('DELETES a live intent absent from the declared set (out-of-band add) — never FallbackIntent (#564)', async () => {
    // live has OrderFlowers + a rogue Rogue intent + the built-in FallbackIntent; declared has
    // only OrderFlowers → Rogue is deleted, OrderFlowers updated, FallbackIntent left alone.
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [
        { intentId: 'I1', intentName: 'OrderFlowers' },
        { intentId: 'IR', intentName: 'Rogue' },
        { intentId: 'IF', intentName: 'FallbackIntent' },
      ],
    });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [] });
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(DeleteIntentCommand).resolves({});
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(declared), [utteranceOp]);
    const deleted = lex.commandCalls(DeleteIntentCommand);
    expect(deleted).toHaveLength(1);
    // ONLY the rogue intent is deleted — the built-in FallbackIntent is never touched
    expect(deleted[0]!.args[0].input.intentId).toBe('IR');
    // the sole declared user intent is updated, none created
    expect(lex.commandCalls(UpdateIntentCommand)).toHaveLength(1);
    expect(lex.commandCalls(CreateIntentCommand)).toHaveLength(0);
  });

  it('CREATES a missing slot type / DELETES an extra one, ordered around the slots (#564)', async () => {
    // live has an extra custom slot type Extra; declared has a custom slot type Flavor + one
    // intent OrderFlowers with a slot bound to Flavor → Flavor is created (missing), the intent's
    // declared slot is created, then Extra is deleted last (after slots resolve).
    lex.on(ListSlotTypesCommand).resolves({
      slotTypeSummaries: [{ slotTypeId: 'STX', slotTypeName: 'Extra' }],
    });
    lex.on(CreateSlotTypeCommand).resolves({ slotTypeId: 'STF', slotTypeName: 'Flavor' });
    lex.on(DescribeSlotTypeCommand).resolves({ slotTypeId: 'STF' } as never);
    lex.on(UpdateSlotTypeCommand).resolves({});
    lex.on(DeleteSlotTypeCommand).resolves({});
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [{ intentId: 'I1', intentName: 'OrderFlowers' }],
    });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [] });
    lex.on(CreateSlotCommand).resolves({ slotId: 'SL1' });
    lex.on(DescribeSlotCommand).resolves({ slotId: 'SL1' } as never);
    lex.on(UpdateSlotCommand).resolves({});
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    const withSlotType = {
      BotLocales: [
        {
          LocaleId: 'en_US',
          SlotTypes: [
            {
              Name: 'Flavor',
              SlotTypeValues: [{ SampleValue: { Value: 'vanilla' } }],
              ValueSelectionSetting: { ResolutionStrategy: 'ORIGINAL_VALUE' },
            },
          ],
          Intents: [
            {
              Name: 'OrderFlowers',
              Slots: [
                {
                  Name: 'Flavor',
                  SlotTypeName: 'Flavor',
                  ValueElicitationSetting: { SlotConstraint: 'Required' },
                },
              ],
            },
          ],
        },
      ],
    };
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(withSlotType), [utteranceOp]);
    const createdSt = lex.commandCalls(CreateSlotTypeCommand);
    expect(createdSt).toHaveLength(1);
    expect(createdSt[0]!.args[0].input.slotTypeName).toBe('Flavor');
    // the declared slot for the intent is created and bound to the just-created slot type id
    const createdSlot = lex.commandCalls(CreateSlotCommand);
    expect(createdSlot).toHaveLength(1);
    expect(createdSlot[0]!.args[0].input.slotName).toBe('Flavor');
    expect(createdSlot[0]!.args[0].input.slotTypeId).toBe('STF');
    // the extra live slot type is deleted (last, once nothing references it)
    const deletedSt = lex.commandCalls(DeleteSlotTypeCommand);
    expect(deletedSt).toHaveLength(1);
    expect(deletedSt[0]!.args[0].input.slotTypeId).toBe('STX');
  });

  it('DELETES a live slot absent from the declared intent (out-of-band add) (#564)', async () => {
    // live intent OrderFlowers carries a rogue slot; declared intent has no slots → delete it.
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [{ intentId: 'I1', intentName: 'OrderFlowers' }],
    });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [{ slotId: 'SR', slotName: 'Rogue' }] });
    lex.on(DeleteSlotCommand).resolves({});
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(declared), [utteranceOp]);
    const deletedSlot = lex.commandCalls(DeleteSlotCommand);
    expect(deletedSlot).toHaveLength(1);
    expect(deletedSlot[0]!.args[0].input.slotId).toBe('SR');
    expect(deletedSlot[0]!.args[0].input.intentId).toBe('I1');
  });

  it('throws when the Bot id is unresolvable', async () => {
    await expect(
      SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(
        lexCtx(declared) && ctx({ physicalId: '', declared }),
        [utteranceOp]
      )
    ).rejects.toThrow(/Lex Bot id/);
  });

  it('PAGINATES ListIntents: a declared intent on page 2 is found (not recreated) (#753)', async () => {
    // live has two intents split across two pages (OrderFlowers on page 1, AddOns on page 2);
    // both are declared. Without following nextToken, AddOns is invisible → the writer would
    // CreateIntent an already-existing name (fails mid-revert). With pagination it is found and
    // only updated.
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex
      .on(ListIntentsCommand)
      .resolvesOnce({
        intentSummaries: [{ intentId: 'I1', intentName: 'OrderFlowers' }],
        nextToken: 'page2',
      })
      .resolvesOnce({ intentSummaries: [{ intentId: 'I2', intentName: 'AddOns' }] });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [] });
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(CreateIntentCommand).resolves({ intentId: 'INEW' });
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    const twoIntents = {
      BotLocales: [
        {
          LocaleId: 'en_US',
          Intents: [
            { Name: 'OrderFlowers', SampleUtterances: [{ Utterance: 'order' }] },
            { Name: 'AddOns', SampleUtterances: [{ Utterance: 'add ons' }] },
          ],
        },
      ],
    };
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(twoIntents), [utteranceOp]);
    // both pages were listed
    expect(lex.commandCalls(ListIntentsCommand)).toHaveLength(2);
    // page-2 AddOns was found → NOT recreated, both intents converged via UpdateIntent
    expect(lex.commandCalls(CreateIntentCommand)).toHaveLength(0);
    expect(lex.commandCalls(DeleteIntentCommand)).toHaveLength(0);
    expect(lex.commandCalls(UpdateIntentCommand)).toHaveLength(2);
  });

  it('PAGINATES ListSlotTypes: a declared slot type on page 2 is found (not recreated) (#753)', async () => {
    lex
      .on(ListSlotTypesCommand)
      .resolvesOnce({
        slotTypeSummaries: [{ slotTypeId: 'ST1', slotTypeName: 'Flavor' }],
        nextToken: 'page2',
      })
      .resolvesOnce({ slotTypeSummaries: [{ slotTypeId: 'ST2', slotTypeName: 'Size' }] });
    lex.on(DescribeSlotTypeCommand).resolves({ slotTypeId: 'ST1' } as never);
    lex.on(CreateSlotTypeCommand).resolves({ slotTypeId: 'STNEW' });
    lex.on(UpdateSlotTypeCommand).resolves({});
    lex.on(DeleteSlotTypeCommand).resolves({});
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [{ intentId: 'I1', intentName: 'OrderFlowers' }],
    });
    lex.on(ListSlotsCommand).resolves({ slotSummaries: [] });
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    const withSlotTypes = {
      BotLocales: [
        {
          LocaleId: 'en_US',
          SlotTypes: [{ Name: 'Flavor' }, { Name: 'Size' }],
          Intents: [{ Name: 'OrderFlowers', SampleUtterances: [{ Utterance: 'order' }] }],
        },
      ],
    };
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(withSlotTypes), [utteranceOp]);
    expect(lex.commandCalls(ListSlotTypesCommand)).toHaveLength(2);
    // page-2 Size was found → NOT recreated, both slot types converged via UpdateSlotType
    expect(lex.commandCalls(CreateSlotTypeCommand)).toHaveLength(0);
    expect(lex.commandCalls(DeleteSlotTypeCommand)).toHaveLength(0);
    expect(lex.commandCalls(UpdateSlotTypeCommand)).toHaveLength(2);
  });

  it('PAGINATES ListSlots: a declared slot on page 2 is found (not recreated) (#753)', async () => {
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [{ intentId: 'I1', intentName: 'OrderFlowers' }],
    });
    lex
      .on(ListSlotsCommand)
      .resolvesOnce({
        slotSummaries: [{ slotId: 'S1', slotName: 'FlavorSlot' }],
        nextToken: 'page2',
      })
      .resolvesOnce({ slotSummaries: [{ slotId: 'S2', slotName: 'SizeSlot' }] });
    lex.on(DescribeSlotCommand).resolves({ slotId: 'S1' } as never);
    lex.on(CreateSlotCommand).resolves({ slotId: 'SNEW' });
    lex.on(UpdateSlotCommand).resolves({});
    lex.on(DeleteSlotCommand).resolves({});
    lex.on(DescribeIntentCommand).resolves({ intentId: 'I1' } as never);
    lex.on(DescribeBotLocaleCommand).resolves({ botLocaleStatus: 'Built' } as never);
    lex.on(UpdateIntentCommand).resolves({});
    lex.on(UpdateBotLocaleCommand).resolves({});
    lex.on(BuildBotLocaleCommand).resolves({});
    const withSlots = {
      BotLocales: [
        {
          LocaleId: 'en_US',
          Intents: [
            {
              Name: 'OrderFlowers',
              SampleUtterances: [{ Utterance: 'order' }],
              Slots: [
                { Name: 'FlavorSlot', ValueElicitationSetting: { SlotConstraint: 'Optional' } },
                { Name: 'SizeSlot', ValueElicitationSetting: { SlotConstraint: 'Optional' } },
              ],
            },
          ],
        },
      ],
    };
    await SDK_NESTED_WRITERS['AWS::Lex::Bot']!.writer(lexCtx(withSlots), [utteranceOp]);
    expect(lex.commandCalls(ListSlotsCommand)).toHaveLength(2);
    // page-2 SizeSlot was found → NOT recreated, both slots converged via UpdateSlot
    expect(lex.commandCalls(CreateSlotCommand)).toHaveLength(0);
    expect(lex.commandCalls(DeleteSlotCommand)).toHaveLength(0);
    expect(lex.commandCalls(UpdateSlotCommand)).toHaveLength(2);
  });
});

describe('ApiGatewayV2 Stage writer (autoDeploy — bypass CC UpdateStage, issue #667)', () => {
  const stageCtx = (over: Partial<OverrideCtx> = {}): OverrideCtx =>
    ctx({
      physicalId: 'prod', // the Ref (bare StageName)
      identifier: 'abc123|prod', // ApiId|StageName resolved by CC_IDENTIFIER_ADAPTERS
      declared: {
        ApiId: 'abc123',
        StageName: 'prod',
        AutoDeploy: true,
        DefaultRouteSettings: { ThrottlingRateLimit: 100, ThrottlingBurstLimit: 50 },
      },
      ...over,
    });
  // an out-of-band mutation dropped ThrottlingRateLimit 100 -> 50; revert restores the declared 100.
  const op: PatchOp = {
    op: 'add',
    path: '/DefaultRouteSettings/ThrottlingRateLimit',
    value: 100,
    human: 'DefaultRouteSettings.ThrottlingRateLimit -> deployed-template value',
  };

  it('routes an ApiGatewayV2::Stage revert to the whole-type SDK writer', () => {
    expect(SDK_WRITERS['AWS::ApiGatewayV2::Stage']).toBeDefined();
    expect(resolveSdkWriter('AWS::ApiGatewayV2::Stage', [op])).toBe(
      SDK_WRITERS['AWS::ApiGatewayV2::Stage']
    );
  });

  it('calls UpdateStage with ONLY the drifted property and NEVER DeploymentId', async () => {
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(stageCtx(), [op]);
    const calls = apigwv2.commandCalls(UpdateApiGatewayV2StageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    // identifier segments resolved from the composite ctx.identifier `ApiId|StageName`.
    expect(input.ApiId).toBe('abc123');
    expect(input.StageName).toBe('prod');
    // ONLY the touched top-level property is sent (the declared desired value).
    expect(input.DefaultRouteSettings).toEqual({
      ThrottlingRateLimit: 100,
      ThrottlingBurstLimit: 50,
    });
    // NEVER DeploymentId (the CC-injected poison auto-deploy stages reject).
    expect(input).not.toHaveProperty('DeploymentId');
    // untouched props are not re-sent.
    expect(input).not.toHaveProperty('RouteSettings');
    expect(input).not.toHaveProperty('AccessLogSettings');
  });

  it('falls back to declared ApiId + physical-id StageName when no composite identifier', async () => {
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(stageCtx({ identifier: undefined }), [op]);
    const input = apigwv2.commandCalls(UpdateApiGatewayV2StageCommand)[0]!.args[0].input;
    expect(input.ApiId).toBe('abc123');
    expect(input.StageName).toBe('prod');
  });

  it('throws when ApiId/StageName are unresolvable', async () => {
    await expect(
      SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(
        ctx({ physicalId: '', identifier: undefined, declared: {} }),
        [op]
      )
    ).rejects.toThrow(/ApiId\|StageName/);
  });
});

describe('ApiGatewayV2 Stage writer — clearing payloads for remove ops (issue #806)', () => {
  // A stage whose only DECLARED intent is the identity + AutoDeploy; every other field is
  // undeclared and was set out of band, so reverting to intent CLEARS it.
  const clearCtx = (over: Partial<OverrideCtx> = {}): OverrideCtx =>
    ctx({
      physicalId: 'prod',
      identifier: 'abc123|prod',
      declared: { ApiId: 'abc123', StageName: 'prod', AutoDeploy: true },
      ...over,
    });

  it('clears a whole StageVariables map via empty-string tombstones (NOT omission)', async () => {
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    // whole-field remove: `prior` carries the live keys the revert drops.
    const removeOp: PatchOp = {
      op: 'remove',
      path: '/StageVariables',
      prior: { env: 'hunt', owner: 'oob' },
      human: 'StageVariables -> remove (undeclared, not in baseline)',
    };
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(clearCtx(), [removeOp]);
    const calls = apigwv2.commandCalls(UpdateApiGatewayV2StageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    // every dropped key is sent with an empty-string value (the only way UpdateStage removes
    // a key; an empty/omitted map is a no-op and MERGE keeps unlisted live keys).
    expect(input.StageVariables).toEqual({ env: '', owner: '' });
    expect(input).not.toHaveProperty('DeploymentId');
  });

  it('clears a single StageVariables key via an empty-string tombstone', async () => {
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    // per-key remove: `/StageVariables/owner`.
    const removeOp: PatchOp = {
      op: 'remove',
      path: '/StageVariables/owner',
      prior: 'oob',
      human: 'StageVariables.owner -> remove (undeclared, not in baseline)',
    };
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(clearCtx(), [removeOp]);
    const input = apigwv2.commandCalls(UpdateApiGatewayV2StageCommand)[0]!.args[0].input;
    expect(input.StageVariables).toEqual({ owner: '' });
  });

  it('clears AccessLogSettings via the dedicated DeleteAccessLogSettings API', async () => {
    apigwv2.on(DeleteAccessLogSettingsCommand).resolves({});
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    const removeOp: PatchOp = {
      op: 'remove',
      path: '/AccessLogSettings',
      prior: { DestinationArn: 'arn:aws:logs:...:lg', Format: '$context.requestId' },
      human: 'AccessLogSettings -> remove (undeclared, not in baseline)',
    };
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(clearCtx(), [removeOp]);
    const del = apigwv2.commandCalls(DeleteAccessLogSettingsCommand);
    expect(del).toHaveLength(1);
    expect(del[0]!.args[0].input).toEqual({ ApiId: 'abc123', StageName: 'prod' });
    // UpdateStage is NOT called with an (ineffective) empty AccessLogSettings object.
    expect(apigwv2.commandCalls(UpdateApiGatewayV2StageCommand)).toHaveLength(0);
  });

  it('clears RouteSettings overrides via DeleteRouteSettings per dropped route key', async () => {
    apigwv2.on(DeleteRouteSettingsCommand).resolves({});
    const removeOp: PatchOp = {
      op: 'remove',
      path: '/RouteSettings',
      prior: {
        'GET /a': { ThrottlingBurstLimit: 10 },
        'POST /b': { ThrottlingRateLimit: 5 },
      },
      human: 'RouteSettings -> remove (undeclared, not in baseline)',
    };
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(clearCtx(), [removeOp]);
    const del = apigwv2.commandCalls(DeleteRouteSettingsCommand);
    expect(del).toHaveLength(2);
    expect(del.map((c) => c.args[0].input.RouteKey).sort()).toEqual(['GET /a', 'POST /b']);
    del.forEach((c) => {
      expect(c.args[0].input.ApiId).toBe('abc123');
      expect(c.args[0].input.StageName).toBe('prod');
    });
    // no UpdateStage: an empty RouteSettings object is a no-op, so the clear is delete-only.
    expect(apigwv2.commandCalls(UpdateApiGatewayV2StageCommand)).toHaveLength(0);
  });

  it('leaves an unclearable Description untouched (no UpdateStage payload for it)', async () => {
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    const removeOp: PatchOp = {
      op: 'remove',
      path: '/Description',
      prior: 'hunt-oob-description',
      human: 'Description -> remove (undeclared, not in baseline)',
    };
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(clearCtx(), [removeOp]);
    // Description has no API clearing path; no UpdateStage is issued for it alone.
    expect(apigwv2.commandCalls(UpdateApiGatewayV2StageCommand)).toHaveLength(0);
  });

  it('clears one field while SETTING another, leaving unrelated live fields untouched', async () => {
    apigwv2.on(UpdateApiGatewayV2StageCommand).resolves({});
    const ops: PatchOp[] = [
      // set DefaultRouteSettings back to the declared value
      {
        op: 'add',
        path: '/DefaultRouteSettings/ThrottlingRateLimit',
        value: 100,
        human: 'DefaultRouteSettings.ThrottlingRateLimit -> deployed-template value',
      },
      // clear an out-of-band StageVariables key
      {
        op: 'remove',
        path: '/StageVariables/owner',
        prior: 'oob',
        human: 'StageVariables.owner -> remove (undeclared, not in baseline)',
      },
    ];
    await SDK_WRITERS['AWS::ApiGatewayV2::Stage']!(
      clearCtx({
        declared: {
          ApiId: 'abc123',
          StageName: 'prod',
          AutoDeploy: true,
          DefaultRouteSettings: { ThrottlingRateLimit: 100 },
        },
      }),
      ops
    );
    const input = apigwv2.commandCalls(UpdateApiGatewayV2StageCommand)[0]!.args[0].input;
    // the SET field carries the desired value...
    expect(input.DefaultRouteSettings).toEqual({ ThrottlingRateLimit: 100 });
    // ...and the CLEAR field carries the empty-string tombstone.
    expect(input.StageVariables).toEqual({ owner: '' });
    // unrelated live fields (RouteSettings/AccessLogSettings) are not re-sent.
    expect(input).not.toHaveProperty('RouteSettings');
    expect(input).not.toHaveProperty('AccessLogSettings');
    expect(input).not.toHaveProperty('DeploymentId');
  });
});

describe('ApiGateway RestApi Policy writer (JSON-string prop, issue #677)', () => {
  const desiredPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: '*',
        Action: 'execute-api:Invoke',
        Resource: 'arn:aws:execute-api:us-east-1:123456789012:wmvd2s08ng/*',
      },
      {
        Effect: 'Deny',
        Principal: '*',
        Action: 'execute-api:Invoke',
        Resource: 'arn:aws:execute-api:us-east-1:123456789012:wmvd2s08ng/*',
        Condition: { StringNotEquals: { 'aws:SourceVpce': 'vpce-1234' } },
      },
    ],
  };
  const restApiCtx = (over: Partial<OverrideCtx> = {}): OverrideCtx =>
    ctx({ physicalId: 'wmvd2s08ng', declared: { Policy: desiredPolicy }, ...over });
  // the finding is a whole-statement declared drift under Policy (parsed object sub-path).
  const op: PatchOp = {
    op: 'add',
    path: '/Policy/Statement',
    value: desiredPolicy.Statement,
    human: 'Policy.Statement -> deployed-template value',
  };

  it('routes a Policy sub-path drift to the nested RestApi SDK writer', () => {
    const writer = resolveSdkWriter('AWS::ApiGateway::RestApi', [op]);
    expect(writer).toBeDefined();
    expect(writer).toBe(SDK_NESTED_WRITERS['AWS::ApiGateway::RestApi']!.writer);
    // a non-Policy drift is NOT captured by this writer (stays on Cloud Control).
    expect(SDK_NESTED_WRITERS['AWS::ApiGateway::RestApi']!.match('Description')).toBe(false);
    expect(SDK_NESTED_WRITERS['AWS::ApiGateway::RestApi']!.match('Policy')).toBe(true);
    expect(SDK_NESTED_WRITERS['AWS::ApiGateway::RestApi']!.match('Policy.Statement')).toBe(true);
  });

  it('replaces /policy with the WHOLE declared policy serialized to a compact JSON string', async () => {
    apigw.on(UpdateRestApiCommand).resolves({});
    await resolveSdkWriter('AWS::ApiGateway::RestApi', [op])!(restApiCtx(), [op]);
    const calls = apigw.commandCalls(UpdateRestApiCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.restApiId).toBe('wmvd2s08ng'); // the RestApi physical id IS the RestApiId.
    expect(input.patchOperations).toEqual([
      { op: 'replace', path: '/policy', value: JSON.stringify(desiredPolicy) },
    ]);
  });

  it('reverts an absent declared policy to the empty string (clears it)', async () => {
    apigw.on(UpdateRestApiCommand).resolves({});
    await resolveSdkWriter('AWS::ApiGateway::RestApi', [op])!(restApiCtx({ declared: {} }), [op]);
    const input = apigw.commandCalls(UpdateRestApiCommand)[0]!.args[0].input;
    expect(input.patchOperations).toEqual([{ op: 'replace', path: '/policy', value: '' }]);
  });

  it('throws when the RestApiId is unresolvable', async () => {
    await expect(
      resolveSdkWriter('AWS::ApiGateway::RestApi', [op])!(
        ctx({ physicalId: '', declared: { Policy: desiredPolicy } }),
        [op]
      )
    ).rejects.toThrow(/RestApiId/);
  });
});

// #1623 — CodeBuild Project revert via the selective codebuild:UpdateProject (the type is
// SDK_OVERRIDES-read, so revert previously said "type not revertable yet" while detection
// worked — live-found by the revconv4-hunt batch-5 probe).
describe('CodeBuild Project writer (selective UpdateProject, #1623)', () => {
  const NAME = 'cdkrd-1623-cb';
  // `as const` keeps the enum-typed fields (source.type / environment.type / computeType)
  // literal so the mock satisfies the SDK's Project union types.
  const cbProject = {
    name: NAME,
    serviceRole: 'arn:aws:iam::123456789012:role/cb',
    timeoutInMinutes: 30,
    queuedTimeoutInMinutes: 240,
    source: { type: 'NO_SOURCE' },
    artifacts: { type: 'NO_ARTIFACTS' },
    environment: {
      type: 'LINUX_CONTAINER',
      computeType: 'BUILD_GENERAL1_SMALL',
      image: 'aws/codebuild/standard:7.0',
    },
  } as const;
  const tOp = (path: string, value: unknown): PatchOp => ({
    op: 'add',
    path,
    value,
    human: `${path} -> AWS default`,
  });

  it('resolveSdkWriter routes the whole type to the SDK writer', () => {
    expect(SDK_WRITERS['AWS::CodeBuild::Project']).toBeDefined();
  });

  it('writes ONLY the touched scalars, camelCased, via UpdateProject', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({ projects: [cbProject] });
    codebuild.on(UpdateProjectCommand).resolves({});
    const writer = SDK_WRITERS['AWS::CodeBuild::Project'];
    await writer(ctx({ physicalId: NAME }), [
      tOp('/TimeoutInMinutes', 60),
      tOp('/QueuedTimeoutInMinutes', 480),
    ]);
    const calls = codebuild.commandCalls(UpdateProjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      name: NAME,
      timeoutInMinutes: 60,
      queuedTimeoutInMinutes: 480,
    });
  });

  it('a removed Description clears with an empty string', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [{ ...cbProject, description: 'oob-added' }],
    });
    codebuild.on(UpdateProjectCommand).resolves({});
    const writer = SDK_WRITERS['AWS::CodeBuild::Project'];
    await writer(ctx({ physicalId: NAME }), [
      { op: 'remove', path: '/Description', prior: 'oob-added', human: 'Description -> remove' },
    ]);
    expect(codebuild.commandCalls(UpdateProjectCommand)[0].args[0].input).toEqual({
      name: NAME,
      description: '',
    });
  });

  it('an op on an unmapped complex shape reports not-reverted honestly (after applying the rest)', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({ projects: [cbProject] });
    codebuild.on(UpdateProjectCommand).resolves({});
    const writer = SDK_WRITERS['AWS::CodeBuild::Project'];
    await expect(
      writer(ctx({ physicalId: NAME }), [
        tOp('/TimeoutInMinutes', 60),
        tOp('/Environment', { Type: 'LINUX_CONTAINER' }),
      ])
    ).rejects.toThrow(/Environment/);
    // the convergeable op still landed before the honest failure
    expect(codebuild.commandCalls(UpdateProjectCommand)).toHaveLength(1);
  });
});

// #1623 — MediaConvert Queue revert via mediaconvert:UpdateQueue (NON_PROVISIONABLE,
// read-only until now).
describe('MediaConvert Queue writer (UpdateQueue, #1623)', () => {
  const NAME = 'cdkrd-1623-mcq';
  // `as const` keeps Status/PricingPlan literal so the mock satisfies the SDK's Queue unions.
  const liveQueue = { Name: NAME, Status: 'PAUSED', PricingPlan: 'ON_DEMAND' } as const;

  it('resolveSdkWriter routes the whole type to the SDK writer', () => {
    expect(SDK_WRITERS['AWS::MediaConvert::Queue']).toBeDefined();
  });

  it('an add Status ACTIVE (the REVERT_SET_DEFAULT_PATHS set-default) writes UpdateQueue', async () => {
    mediaconvert.on(GetQueueCommand).resolves({ Queue: liveQueue });
    mediaconvert.on(UpdateQueueCommand).resolves({});
    const writer = SDK_WRITERS['AWS::MediaConvert::Queue'];
    await writer(ctx({ physicalId: NAME }), [
      { op: 'add', path: '/Status', value: 'ACTIVE', prior: 'PAUSED', human: 'Status -> default' },
    ]);
    const calls = mediaconvert.commandCalls(UpdateQueueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({ Name: NAME, Status: 'ACTIVE' });
  });

  it('an op on an unmapped prop reports not-reverted honestly', async () => {
    mediaconvert.on(GetQueueCommand).resolves({ Queue: liveQueue });
    mediaconvert.on(UpdateQueueCommand).resolves({});
    const writer = SDK_WRITERS['AWS::MediaConvert::Queue'];
    await expect(
      writer(ctx({ physicalId: NAME }), [
        { op: 'add', path: '/Tags', value: { a: 'b' }, human: 'Tags -> value' },
      ])
    ).rejects.toThrow(/Tags/);
  });
});

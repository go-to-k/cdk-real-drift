import {
  APIGatewayClient,
  UpdateIntegrationCommand,
  UpdateIntegrationResponseCommand,
  UpdateMethodResponseCommand,
} from '@aws-sdk/client-api-gateway';
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
  GetClassifierCommand,
  GetJobCommand,
  GetTableCommand,
  GetWorkflowCommand,
  GlueClient,
  UpdateClassifierCommand,
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
  ServiceDiscoveryClient,
  UpdateHttpNamespaceCommand,
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
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import type { PatchOp } from '../src/revert/plan.js';
import { resolveSdkWriter, SDK_WRITERS } from '../src/revert/writers.js';

const iam = mockClient(IAMClient);
const elb = mockClient(ElasticLoadBalancingV2Client);
const sns = mockClient(SNSClient);
const sqs = mockClient(SQSClient);
const serviceDiscovery = mockClient(ServiceDiscoveryClient);
const docdb = mockClient(DocDBClient);
const cloudfront = mockClient(CloudFrontClient);
const wafv2 = mockClient(WAFV2Client);
const opensearch = mockClient(OpenSearchClient);
const glue = mockClient(GlueClient);
const logs = mockClient(CloudWatchLogsClient);
const route53 = mockClient(Route53Client);
const configService = mockClient(ConfigServiceClient);
const eventbridge = mockClient(EventBridgeClient);
const apigw = mockClient(APIGatewayClient);
const ecs = mockClient(ECSClient);
const cloudcontrol = mockClient(CloudControlClient);

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
  docdb.reset();
  cloudfront.reset();
  wafv2.reset();
  opensearch.reset();
  glue.reset();
  logs.reset();
  route53.reset();
  configService.reset();
  eventbridge.reset();
  apigw.reset();
  ecs.reset();
  cloudcontrol.reset();
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

  it('throws when the workflow name is unresolvable', async () => {
    glue.on(GetWorkflowCommand).resolves({ Workflow: undefined } as never);
    await expect(
      SDK_WRITERS['AWS::Glue::Workflow'](ctx({ physicalId: '', declared: {} }), [runsOp(3)])
    ).rejects.toThrow(/Glue workflow target/);
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

  it('does NOT send EngineVersion (off the safe-modify allowlist -> no accidental upgrade)', async () => {
    stubClusterRead({ EngineVersion: '4.0.0' });
    docdb.on(ModifyDBClusterCommand).resolves({});
    // a hypothetical EngineVersion revert op must be ignored (no modifiable param emitted)
    await SDK_WRITERS['AWS::DocDB::DBCluster'](ctx({ physicalId: CLID }), [
      { op: 'add', path: '/EngineVersion', value: '5.0.0', human: 'x' },
    ]);
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

  it('ignores an op off the safe-modify allowlist (AutoMinorVersionUpgrade is cluster-managed)', async () => {
    stubInstanceRead({ AutoMinorVersionUpgrade: true });
    docdb.on(ModifyDBInstanceCommand).resolves({});
    // AutoMinorVersionUpgrade is a DocDB CLUSTER setting — ModifyDBInstance rejects it, so
    // it is OFF the instance allowlist and an op on it must be ignored (no Modify call).
    await SDK_WRITERS['AWS::DocDB::DBInstance'](ctx({ physicalId: IID }), [
      { op: 'add', path: '/AutoMinorVersionUpgrade', value: false, human: 'x' },
    ]);
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

  it('throws when the rule cannot be found (no silent no-op)', async () => {
    configService.on(DescribeConfigRulesCommand).resolves({ ConfigRules: [] });
    const writer = resolveSdkWriter('AWS::Config::ConfigRule', [inputParamsOp({ a: 1 })])!;
    await expect(writer(ctx({ physicalId: 'missing' }), [inputParamsOp({ a: 1 })])).rejects.toThrow(
      /Config rule not found/
    );
  });
});

describe('Cloud Control index-revert writer (array-element nested values)', () => {
  const ctx = (resourceType: string, physicalId: string): OverrideCtx => ({
    physicalId,
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
    cloudcontrol.on(UpdateResourceCommand).resolves({});
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
    cloudcontrol.on(UpdateResourceCommand).resolves({});
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
});

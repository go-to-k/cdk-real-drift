import { AppSyncClient, ListApiKeysCommand } from '@aws-sdk/client-appsync';
import { CloudWatchClient, DescribeAnomalyDetectorsCommand } from '@aws-sdk/client-cloudwatch';
import { DLMClient, GetLifecyclePolicyCommand } from '@aws-sdk/client-dlm';
import {
  DatabaseMigrationServiceClient,
  DescribeEndpointsCommand,
  DescribeReplicationInstancesCommand,
  DescribeReplicationSubnetGroupsCommand,
  DescribeReplicationTasksCommand,
  ListTagsForResourceCommand as DmsListTagsForResourceCommand,
} from '@aws-sdk/client-database-migration-service';
import {
  GetJobTemplateCommand,
  GetQueueCommand,
  MediaConvertClient,
} from '@aws-sdk/client-mediaconvert';
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import {
  BatchGetProjectsCommand,
  BatchGetReportGroupsCommand,
  CodeBuildClient,
} from '@aws-sdk/client-codebuild';
import {
  DescribeClientVpnAuthorizationRulesCommand,
  DescribeClientVpnEndpointsCommand,
  DescribeClientVpnTargetNetworksCommand,
  DescribeNetworkAclsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DAXClient,
  DescribeClustersCommand,
  DescribeParameterGroupsCommand,
  DescribeParametersCommand as DescribeDaxParametersCommand,
  DescribeSubnetGroupsCommand,
} from '@aws-sdk/client-dax';
import {
  DescribeCacheParameterGroupsCommand,
  DescribeCacheParametersCommand,
  ElastiCacheClient,
} from '@aws-sdk/client-elasticache';
import {
  DescribeParameterGroupsCommand as DescribeMemoryDbParameterGroupsCommand,
  DescribeParametersCommand as DescribeMemoryDbParametersCommand,
  MemoryDBClient,
} from '@aws-sdk/client-memorydb';
import {
  DescribeBotLocaleCommand,
  DescribeIntentCommand,
  DescribeSlotCommand,
  DescribeSlotTypeCommand,
  LexModelsV2Client,
  ListBotLocalesCommand,
  ListIntentsCommand,
  ListSlotsCommand,
  ListSlotTypesCommand,
} from '@aws-sdk/client-lex-models-v2';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DocDBClient,
  ListTagsForResourceCommand as DocDbListTagsForResourceCommand,
} from '@aws-sdk/client-docdb';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeConfigurationSettingsCommand,
  ElasticBeanstalkClient,
} from '@aws-sdk/client-elastic-beanstalk';
import {
  GetClassifierCommand,
  GetConnectionCommand,
  GetTableCommand,
  GetWorkflowCommand,
  GlueClient,
} from '@aws-sdk/client-glue';
import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListEntitiesForPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import {
  DescribeResourceCommand as DescribeLakeFormationResourceCommand,
  EntityNotFoundException as LakeFormationEntityNotFoundException,
  LakeFormationClient,
} from '@aws-sdk/client-lakeformation';
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from '@aws-sdk/client-lambda';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  DescribeReceiptRuleCommand,
  DescribeReceiptRuleSetCommand,
  ListReceiptFiltersCommand,
  SESClient,
} from '@aws-sdk/client-ses';
import { GetConfigurationSetEventDestinationsCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import {
  GetNamespaceCommand,
  GetServiceCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SDK_OVERRIDES, SDK_SUPPLEMENTS } from '../src/read/overrides.js';
import { ResourceGoneError } from '../src/aws-errors.js';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';

const s3 = mockClient(S3Client);
const sns = mockClient(SNSClient);
const sqs = mockClient(SQSClient);
const iam = mockClient(IAMClient);
const lambda = mockClient(LambdaClient);
const budgets = mockClient(BudgetsClient);
const route53 = mockClient(Route53Client);
const glue = mockClient(GlueClient);
const logs = mockClient(CloudWatchLogsClient);
const scheduler = mockClient(SchedulerClient);
const codebuild = mockClient(CodeBuildClient);
const appsync = mockClient(AppSyncClient);
const serviceDiscovery = mockClient(ServiceDiscoveryClient);
const docdb = mockClient(DocDBClient);
const ec2 = mockClient(EC2Client);
const ses = mockClient(SESClient);
const sesv2 = mockClient(SESv2Client);
const cloudwatch = mockClient(CloudWatchClient);
const dlm = mockClient(DLMClient);
const dms = mockClient(DatabaseMigrationServiceClient);
const lakeformation = mockClient(LakeFormationClient);
const mediaconvert = mockClient(MediaConvertClient);
const dax = mockClient(DAXClient);
const elasticache = mockClient(ElastiCacheClient);
const memorydb = mockClient(MemoryDBClient);
const eb = mockClient(ElasticBeanstalkClient);
const lex = mockClient(LexModelsV2Client);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});
const POLICY =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:Get","Resource":"*"}]}';

beforeEach(() => {
  for (const m of [
    s3,
    sns,
    sqs,
    iam,
    lambda,
    budgets,
    route53,
    glue,
    logs,
    scheduler,
    codebuild,
    serviceDiscovery,
    docdb,
    appsync,
    ec2,
    ses,
    sesv2,
    cloudwatch,
    dlm,
    dms,
    lakeformation,
    mediaconvert,
    dax,
    elasticache,
    memorydb,
    lex,
    eb,
  ])
    m.reset();
  // #1287 — the DMS/DocDB readers now fetch tags via ListTagsForResource. Default them to
  // empty so unrelated cases exercise the (Tags-absent) success path, not the degrade warn.
  // A case that wants to assert tag projection / degrade overrides this per-test.
  dms.on(DmsListTagsForResourceCommand).resolves({ TagList: [] });
  docdb.on(DocDbListTagsForResourceCommand).resolves({ TagList: [] });
});

describe('SDK overrides', () => {
  it('S3 BucketPolicy: reads + parses PolicyDocument', async () => {
    s3.on(GetBucketPolicyCommand).resolves({ Policy: POLICY });
    const out = await SDK_OVERRIDES['AWS::S3::BucketPolicy'](ctx({ Bucket: 'my-bucket' }));
    expect(out).toEqual({ Bucket: 'my-bucket', PolicyDocument: JSON.parse(POLICY) });
  });
  it('S3 BucketPolicy: undefined when Bucket unresolved', async () => {
    expect(await SDK_OVERRIDES['AWS::S3::BucketPolicy'](ctx({}))).toBeUndefined();
  });

  it('SNS TopicPolicy: reads Policy attribute', async () => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: POLICY } });
    const out = await SDK_OVERRIDES['AWS::SNS::TopicPolicy'](
      ctx({ Topics: ['arn:aws:sns:us-east-1:1:t'] })
    );
    expect(out).toMatchObject({ PolicyDocument: JSON.parse(POLICY) });
  });

  it('SQS QueuePolicy: reads Policy attribute', async () => {
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: POLICY } });
    const out = await SDK_OVERRIDES['AWS::SQS::QueuePolicy'](ctx({ Queues: ['https://sqs/q'] }));
    expect(out).toMatchObject({ PolicyDocument: JSON.parse(POLICY) });
  });

  it('IAM Policy: reads inline role policy (URL-decoded)', async () => {
    iam.on(GetRolePolicyCommand).resolves({ PolicyDocument: encodeURIComponent(POLICY) });
    const out = await SDK_OVERRIDES['AWS::IAM::Policy'](ctx({ PolicyName: 'p', Roles: ['r'] }));
    expect(out).toMatchObject({
      PolicyName: 'p',
      PolicyDocument: JSON.parse(POLICY),
      Roles: ['r'],
    });
  });

  it('IAM ManagedPolicy: reads default version document by ARN', async () => {
    iam
      .on(GetPolicyCommand)
      .resolves({ Policy: { DefaultVersionId: 'v2', Path: '/', Description: 'd' } });
    iam
      .on(GetPolicyVersionCommand)
      .resolves({ PolicyVersion: { Document: encodeURIComponent(POLICY) } });
    const out = await SDK_OVERRIDES['AWS::IAM::ManagedPolicy'](
      ctx({}, 'arn:aws:iam::123:policy/p')
    );
    expect(out).toMatchObject({ PolicyDocument: JSON.parse(POLICY), Path: '/', Description: 'd' });
  });
  it('IAM ManagedPolicy: undefined when physical id is not an ARN', async () => {
    expect(await SDK_OVERRIDES['AWS::IAM::ManagedPolicy'](ctx({}, 'not-an-arn'))).toBeUndefined();
  });
  it('IAM ManagedPolicy: an OMITTED Description reads as "" — the empty description (R69)', async () => {
    // GetPolicy omits Description when empty, while CDK declares Description: "";
    // an undefined-valued key produced desired-vs-undefined false declared drift.
    iam.on(GetPolicyCommand).resolves({ Policy: { DefaultVersionId: 'v1', Path: '/' } });
    iam
      .on(GetPolicyVersionCommand)
      .resolves({ PolicyVersion: { Document: encodeURIComponent(POLICY) } });
    const out = await SDK_OVERRIDES['AWS::IAM::ManagedPolicy'](
      ctx({}, 'arn:aws:iam::123:policy/p')
    );
    expect(out!.Description).toBe('');
  });
  it('IAM ManagedPolicy: reads the live attachment lists (Roles/Users/Groups), paginated', async () => {
    iam.on(GetPolicyCommand).resolves({ Policy: { DefaultVersionId: 'v1', Path: '/' } });
    iam
      .on(GetPolicyVersionCommand)
      .resolves({ PolicyVersion: { Document: encodeURIComponent(POLICY) } });
    // two pages of attached entities, the first truncated with a Marker.
    iam
      .on(ListEntitiesForPolicyCommand)
      .resolvesOnce({ PolicyRoles: [{ RoleName: 'RoleA' }], IsTruncated: true, Marker: 'm1' })
      .resolves({
        PolicyRoles: [{ RoleName: 'RoleB' }],
        PolicyUsers: [{ UserName: 'UserA' }],
        PolicyGroups: [{ GroupName: 'GroupA' }],
      });
    const out = await SDK_OVERRIDES['AWS::IAM::ManagedPolicy'](
      ctx({}, 'arn:aws:iam::123:policy/p')
    );
    expect(out).toMatchObject({
      Roles: ['RoleA', 'RoleB'],
      Users: ['UserA'],
      Groups: ['GroupA'],
    });
    expect(iam.commandCalls(ListEntitiesForPolicyCommand)).toHaveLength(2);
  });

  it('IAM AccessKey (#716): reads Status for the key matching the physical id', async () => {
    iam.on(ListAccessKeysCommand).resolves({
      AccessKeyMetadata: [
        { UserName: 'svc', AccessKeyId: 'AKIAOTHER', Status: 'Active', CreateDate: new Date(0) },
        { UserName: 'svc', AccessKeyId: 'AKIATARGET', Status: 'Inactive', CreateDate: new Date(0) },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::IAM::AccessKey'](ctx({ UserName: 'svc' }, 'AKIATARGET'));
    // only Status (mutable) + UserName are projected — the secret is never read
    expect(out).toEqual({ UserName: 'svc', Status: 'Inactive' });
  });

  it('IAM AccessKey (#716): undefined when no declared UserName', async () => {
    // no UserName -> cannot resolve the owning user -> skipped, not a wrong deleted claim
    expect(await SDK_OVERRIDES['AWS::IAM::AccessKey'](ctx({}, 'AKIATARGET'))).toBeUndefined();
  });

  it('IAM AccessKey (#965): the user exists but the exact key id is absent -> ResourceGoneError (deleted, not skipped)', async () => {
    // ListAccessKeys succeeds (the user is present — a deleted user throws NoSuchEntity)
    // yet the physical id (the AccessKeyId) is absent = the key was deleted out of band
    // (credential rotation). The single page is authoritative (<=2 keys per user).
    iam.on(ListAccessKeysCommand).resolves({
      AccessKeyMetadata: [
        { UserName: 'svc', AccessKeyId: 'AKIAOTHER', Status: 'Active', CreateDate: new Date(0) },
      ],
    });
    await expect(
      SDK_OVERRIDES['AWS::IAM::AccessKey'](ctx({ UserName: 'svc' }, 'AKIATARGET'))
    ).rejects.toBeInstanceOf(ResourceGoneError);
  });

  it('Lambda Permission: matches statement by Action + Principal', async () => {
    const fnPolicy = JSON.stringify({
      Statement: [
        { Sid: 'x', Action: 'lambda:InvokeFunction', Principal: { Service: 's3.amazonaws.com' } },
      ],
    });
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: fnPolicy });
    const out = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com' })
    );
    expect(out).toMatchObject({ FunctionName: 'f', Action: 'lambda:InvokeFunction' });
  });

  it('Lambda Permission: disambiguates by Sid (physical id) when statements share Action+Principal', async () => {
    // The CDK API Gateway integration emits TWO permissions on one function — the
    // deployment-stage one and a parallel `test-invoke-stage` one — identical in
    // Action + Principal, differing only in SourceArn. Without a Sid match the
    // Action+Principal `.find()` returns the FIRST for BOTH, so the prod permission
    // read back the test-invoke-stage SourceArn (a false `declared` drift every deploy).
    const fnPolicy = JSON.stringify({
      Statement: [
        {
          Sid: 'stack-ApiPermissionTest-aaa',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'apigateway.amazonaws.com' },
          Condition: {
            ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:r:1:api/test-invoke-stage/POST/X' },
          },
        },
        {
          Sid: 'stack-ApiPermission-bbb',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'apigateway.amazonaws.com' },
          Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:r:1:api/prod/POST/X' } },
        },
      ],
    });
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: fnPolicy });
    // the prod permission's physical id IS its statement Sid -> match it exactly
    const out = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx(
        {
          FunctionName: 'f',
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
        },
        'stack-ApiPermission-bbb'
      )
    );
    expect(out).toMatchObject({
      SourceArn: 'arn:aws:execute-api:r:1:api/prod/POST/X',
    });
    // and the test-invoke-stage permission reads back its OWN SourceArn (not the first)
    const outTest = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx(
        {
          FunctionName: 'f',
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
        },
        'stack-ApiPermissionTest-aaa'
      )
    );
    expect(outTest).toMatchObject({
      SourceArn: 'arn:aws:execute-api:r:1:api/test-invoke-stage/POST/X',
    });
  });

  it('Lambda Permission (#1084): a deleted statement with a concrete Sid + siblings remaining -> ResourceGoneError (deleted, not a sibling match)', async () => {
    // The policy still exists (siblings remain) but the declared permission's own
    // statement (Sid `stack-ApiPermission-bbb`) was deleted out of band. A sibling
    // shares Action + Principal, so the old Action+Principal fallback would have
    // matched it and read back the WRONG SourceArn (hiding the deletion). Because
    // the physical id IS a concrete StatementId, the exact-Sid miss is authoritative.
    const fnPolicy = JSON.stringify({
      Statement: [
        {
          Sid: 'stack-ApiPermissionTest-aaa',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'apigateway.amazonaws.com' },
          Condition: {
            ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:r:1:api/test-invoke-stage/POST/X' },
          },
        },
      ],
    });
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: fnPolicy });
    await expect(
      SDK_OVERRIDES['AWS::Lambda::Permission'](
        ctx(
          {
            FunctionName: 'f',
            Action: 'lambda:InvokeFunction',
            Principal: 'apigateway.amazonaws.com',
          },
          'stack-ApiPermission-bbb'
        )
      )
    ).rejects.toBeInstanceOf(ResourceGoneError);
  });

  it('Lambda Permission (#1084): no usable StatementId (empty physical id) keeps the Action+Principal fallback', async () => {
    // A pre-deploy / unresolved-ref read leaves the physical id empty, so there is no
    // authoritative Sid to key on. The best-effort Action+Principal fallback must still
    // run (unchanged behavior) — it must NOT throw ResourceGoneError.
    const fnPolicy = JSON.stringify({
      Statement: [
        {
          Sid: 'auto-generated-sid',
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 's3.amazonaws.com' },
        },
      ],
    });
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: fnPolicy });
    const out = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      // physicalId defaults to '' (not a usable StatementId)
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com' })
    );
    expect(out).toMatchObject({ FunctionName: 'f', Action: 'lambda:InvokeFunction' });
  });

  // R12: return the matched statement's REAL fields, never echo the declared template.
  it('Lambda Permission: returns the REAL statement Principal, not the declared echo', async () => {
    // declared Principal is stale ("old.amazonaws.com"); AWS actually has events
    const fnPolicy = JSON.stringify({
      Statement: [
        {
          Action: 'lambda:InvokeFunction',
          Principal: { Service: 'events.amazonaws.com' },
        },
      ],
    });
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: fnPolicy });
    const out = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      // matcher uses Action only (declared Principal won't substring-match the live one)
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction' })
    );
    // real value surfaces so a Principal drift is detectable
    expect(out).toMatchObject({ Principal: 'events.amazonaws.com' });
  });

  it('Lambda Permission: normalizes {AWS:x} and plain-string principals', async () => {
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [{ Action: 'lambda:InvokeFunction', Principal: { AWS: '123456789012' } }],
      }),
    });
    expect(
      await SDK_OVERRIDES['AWS::Lambda::Permission'](
        ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction' })
      )
    ).toMatchObject({ Principal: '123456789012' });

    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [{ Action: 'lambda:InvokeFunction', Principal: '*' }],
      }),
    });
    expect(
      await SDK_OVERRIDES['AWS::Lambda::Permission'](
        ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction' })
      )
    ).toMatchObject({ Principal: '*' });
  });

  it('Lambda Permission: extracts SourceArn/SourceAccount from Condition; omits when absent', async () => {
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Principal: { Service: 's3.amazonaws.com' },
            Condition: {
              ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::my-bucket' },
              StringEquals: { 'AWS:SourceAccount': '111122223333' },
            },
          },
        ],
      }),
    });
    const out = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction' })
    );
    expect(out).toEqual({
      FunctionName: 'f',
      Action: 'lambda:InvokeFunction',
      Principal: 's3.amazonaws.com',
      SourceArn: 'arn:aws:s3:::my-bucket',
      SourceAccount: '111122223333',
    });

    // no Condition -> SourceArn/SourceAccount omitted (honest readGap, never fabricated)
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          { Action: 'lambda:InvokeFunction', Principal: { Service: 's3.amazonaws.com' } },
        ],
      }),
    });
    const out2 = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction' })
    );
    expect(out2).not.toHaveProperty('SourceArn');
    expect(out2).not.toHaveProperty('SourceAccount');
  });

  it('Lambda Permission: extracts PrincipalOrgID + FunctionUrlAuthType (security scoping); omits when absent', async () => {
    // an org-scoped, function-URL permission — both security conditions present.
    // Note the verbatim casing: lowercase `aws:`/`lambda:`, unlike `AWS:Source*`.
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          {
            Action: 'lambda:InvokeFunctionUrl',
            Principal: '*',
            Condition: {
              StringEquals: {
                'aws:PrincipalOrgID': 'o-abc1234567',
                'lambda:FunctionUrlAuthType': 'AWS_IAM',
              },
            },
          },
        ],
      }),
    });
    const out = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunctionUrl' })
    );
    // both scoping values surface, so dropping the org condition or flipping the URL
    // auth type to NONE out of band is now detectable drift
    expect(out).toMatchObject({
      PrincipalOrgID: 'o-abc1234567',
      FunctionUrlAuthType: 'AWS_IAM',
    });

    // a plain permission (no such conditions) projects neither — no first-run noise
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          {
            Action: 'lambda:InvokeFunction',
            Principal: { Service: 's3.amazonaws.com' },
            Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::b' } },
          },
        ],
      }),
    });
    const out2 = await SDK_OVERRIDES['AWS::Lambda::Permission'](
      ctx({ FunctionName: 'f', Action: 'lambda:InvokeFunction' })
    );
    expect(out2).not.toHaveProperty('PrincipalOrgID');
    expect(out2).not.toHaveProperty('FunctionUrlAuthType');
  });

  it('Lambda Permission: GetPolicy ResourceNotFoundException propagates (R1 intact)', async () => {
    const err = Object.assign(new Error('no policy'), { name: 'ResourceNotFoundException' });
    lambda.on(LambdaGetPolicyCommand).rejects(err);
    await expect(
      SDK_OVERRIDES['AWS::Lambda::Permission'](ctx({ FunctionName: 'f', Action: 'a' }))
    ).rejects.toThrow('no policy');
  });

  it('Lambda Permission: undefined when no statement matches (best-effort)', async () => {
    lambda.on(LambdaGetPolicyCommand).resolves({
      Policy: JSON.stringify({
        Statement: [
          { Action: 'lambda:InvokeFunction', Principal: { Service: 's3.amazonaws.com' } },
        ],
      }),
    });
    expect(
      await SDK_OVERRIDES['AWS::Lambda::Permission'](
        ctx({ FunctionName: 'f', Action: 'lambda:Nonexistent' })
      )
    ).toBeUndefined();
  });

  it('Budgets: projects BudgetLimit + CostFilters (scope), never the computed CalculatedSpend', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '40.0', Unit: 'USD' },
        CostFilters: { Service: ['Amazon Simple Storage Service'] }, // the budget's SCOPE — must be compared
        CalculatedSpend: { ActualSpend: { Amount: '12.3', Unit: 'USD' } }, // computed — never projected
      },
    });
    const out = await SDK_OVERRIDES['AWS::Budgets::Budget'](ctx({ Budget: { BudgetName: 'b' } }));
    expect(out).toEqual({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '40.0', Unit: 'USD' },
        CostFilters: { Service: ['Amazon Simple Storage Service'] },
      },
    });
  });
  it('Budgets: projects PlannedBudgetLimits + THIN AutoAdjustData, dropping the computed auto-adjust fields', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        PlannedBudgetLimits: { '1700000000': { Amount: '40.0', Unit: 'USD' } },
        AutoAdjustData: {
          AutoAdjustType: 'HISTORICAL',
          // BudgetAdjustmentPeriod is user-set; LookBackAvailablePeriods is AWS-computed
          HistoricalOptions: { BudgetAdjustmentPeriod: 6, LookBackAvailablePeriods: 3 },
          LastAutoAdjustTime: new Date(0), // computed -> must be dropped
        },
      },
    });
    const out = await SDK_OVERRIDES['AWS::Budgets::Budget'](ctx({ Budget: { BudgetName: 'b' } }));
    expect(out).toEqual({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        PlannedBudgetLimits: { '1700000000': { Amount: '40.0', Unit: 'USD' } },
        // only the user-settable auto-adjust fields; LookBackAvailablePeriods +
        // LastAutoAdjustTime (computed) are dropped so they are not live-only noise
        AutoAdjustData: {
          AutoAdjustType: 'HISTORICAL',
          HistoricalOptions: { BudgetAdjustmentPeriod: 6 },
        },
      },
    });
  });
  it('Budgets: undefined without a budget name', async () => {
    expect(await SDK_OVERRIDES['AWS::Budgets::Budget'](ctx({ Budget: {} }))).toBeUndefined();
  });
  it('Budgets: resolves by PHYSICAL ID when the template declares no name (R65)', async () => {
    // the CFn-generated-name case: the physical id IS the budget name
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: { BudgetName: 'CfnBudget-us-east-1-123-abc', BudgetType: 'COST', TimeUnit: 'DAILY' },
    });
    const out = await SDK_OVERRIDES['AWS::Budgets::Budget'](
      ctx({ Budget: {} }, 'CfnBudget-us-east-1-123-abc')
    );
    expect(out).toEqual({
      Budget: { BudgetName: 'CfnBudget-us-east-1-123-abc', BudgetType: 'COST', TimeUnit: 'DAILY' },
    });
    const input = budgets.commandCalls(DescribeBudgetCommand).at(-1)!.args[0].input;
    expect(input.BudgetName).toBe('CfnBudget-us-east-1-123-abc');
  });

  describe('Route53 RecordSet', () => {
    it('reads an alias record + aligns the trailing dot to the declared style', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          {
            Name: 'app.example.com.',
            Type: 'A',
            AliasTarget: {
              DNSName: 'd123.cloudfront.net.', // AWS always has the trailing dot
              HostedZoneId: 'Z2FDTNDATAQYW2',
              EvaluateTargetHealth: false,
            },
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx(
          {
            HostedZoneId: 'Z123',
            Name: 'app.example.com.',
            Type: 'A',
            AliasTarget: { DNSName: 'd123.cloudfront.net' }, // declared (GetAtt) has NO dot
          },
          'Z123_app.example.com._A'
        )
      );
      // the alias DNSName trailing dot is aligned to the declared (dot-less) form
      expect(out).toEqual({
        Name: 'app.example.com.',
        Type: 'A',
        HostedZoneId: 'Z123',
        AliasTarget: {
          DNSName: 'd123.cloudfront.net',
          HostedZoneId: 'Z2FDTNDATAQYW2',
          EvaluateTargetHealth: false,
        },
      });
    });

    it('reads a plain record (TTL as string + ResourceRecords)', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          { Name: 'x.example.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"hi"' }] },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({ HostedZoneId: 'Z1', Name: 'x.example.com.', Type: 'TXT' })
      );
      expect(out).toMatchObject({ Type: 'TXT', TTL: '300', ResourceRecords: ['"hi"'] });
    });

    it('projects GeoProximityLocation + CidrRoutingConfig (geoproximity/CIDR routing variants)', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          {
            Name: 'geo.example.com.',
            Type: 'A',
            SetIdentifier: 'g1',
            TTL: 60,
            ResourceRecords: [{ Value: '1.2.3.4' }],
            GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: 10 },
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({ HostedZoneId: 'Z1', Name: 'geo.example.com.', Type: 'A', SetIdentifier: 'g1' })
      )) as Record<string, unknown>;
      expect(out.GeoProximityLocation).toEqual({ AWSRegion: 'us-east-1', Bias: 10 });

      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          {
            Name: 'cidr.example.com.',
            Type: 'A',
            SetIdentifier: 'c1',
            TTL: 60,
            ResourceRecords: [{ Value: '1.2.3.4' }],
            CidrRoutingConfig: { CollectionId: 'col-123', LocationName: 'loc-a' },
          },
        ],
      });
      const out2 = (await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({ HostedZoneId: 'Z1', Name: 'cidr.example.com.', Type: 'A', SetIdentifier: 'c1' })
      )) as Record<string, unknown>;
      expect(out2.CidrRoutingConfig).toEqual({ CollectionId: 'col-123', LocationName: 'loc-a' });
    });

    it('FP-safe: a simple record has neither routing object (no noise)', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          { Name: 'x.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '1.2.3.4' }] },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({ HostedZoneId: 'Z1', Name: 'x.example.com.', Type: 'A' })
      )) as Record<string, unknown>;
      expect(out.GeoProximityLocation).toBeUndefined();
      expect(out.CidrRoutingConfig).toBeUndefined();
    });

    it('zone queried but the declared record absent -> ResourceGoneError (deleted, not skipped)', async () => {
      // The zone exists and was listed; the declared name+type record is gone -> deleted
      // out of band. (Was a false `undefined`/skipped that hid the deletion.)
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [{ Name: 'other.example.com.', Type: 'A' }],
      });
      await expect(
        SDK_OVERRIDES['AWS::Route53::RecordSet'](
          ctx({ HostedZoneId: 'Z1', Name: 'app.example.com.', Type: 'A' })
        )
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('undefined (skipped) when the target cannot be resolved from the template', async () => {
      // No HostedZoneId/Name/Type in declared and a non-composite physical id -> the
      // query can't be formed: stay skipped (NOT deleted), the list is never even called.
      expect(await SDK_OVERRIDES['AWS::Route53::RecordSet'](ctx({}, 'opaque-id'))).toBeUndefined();
    });

    it('#1660: resolves a record declared via HostedZoneName (no HostedZoneId) to a zone id and reads it', async () => {
      // A record can reference its zone by NAME instead of id (both valid CFn). The bare-name
      // physical id carries no zone id either, so without resolving the name this would be a
      // readGap. ListHostedZonesByName resolves the apex -> zone id, then the record is read.
      route53.on(ListHostedZonesByNameCommand).resolves({
        HostedZones: [{ Id: '/hostedzone/Z9', Name: 'example.com.', CallerReference: 'r1' }],
      });
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          { Name: 'x.example.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"hi"' }] },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx(
          { HostedZoneName: 'example.com.', Name: 'x.example.com.', Type: 'TXT' },
          'x.example.com'
        )
      )) as Record<string, unknown>;
      expect(out).toMatchObject({ Type: 'TXT', TTL: '300', ResourceRecords: ['"hi"'] });
      // the resolved (prefix-stripped) zone id is used for ListResourceRecordSets
      const listCall = route53.commandCalls(ListResourceRecordSetsCommand)[0];
      expect(listCall.args[0].input.HostedZoneId).toBe('Z9');
      // the model MIRRORS the declared identifier: echoes HostedZoneName, does NOT emit the
      // resolved HostedZoneId (which would surface as undeclared drift on a clean deploy).
      expect(out.HostedZoneName).toBe('example.com.');
      expect(out.HostedZoneId).toBeUndefined();
    });

    it('#1660: fail-open (readGap) when a HostedZoneName resolves to MULTIPLE zones (public/private split)', async () => {
      // One apex can host both a public and a private zone; picking either would compare the
      // record against the wrong zone, so stay a readGap (undefined) and never list records.
      route53.on(ListHostedZonesByNameCommand).resolves({
        HostedZones: [
          { Id: '/hostedzone/Zpub', Name: 'example.com.', CallerReference: 'r1' },
          { Id: '/hostedzone/Zpriv', Name: 'example.com.', CallerReference: 'r2' },
        ],
      });
      expect(
        await SDK_OVERRIDES['AWS::Route53::RecordSet'](
          ctx(
            { HostedZoneName: 'example.com.', Name: 'x.example.com.', Type: 'TXT' },
            'x.example.com'
          )
        )
      ).toBeUndefined();
      expect(route53.commandCalls(ListResourceRecordSetsCommand)).toHaveLength(0);
    });

    it('#1660: fail-open (readGap) when a HostedZoneName resolves to ZERO zones', async () => {
      route53.on(ListHostedZonesByNameCommand).resolves({
        // ListHostedZonesByName returns the lexicographically-nearest zones even with no exact
        // match; the exact-apex filter must reject them.
        HostedZones: [
          { Id: '/hostedzone/Zother', Name: 'other.example.org.', CallerReference: 'r3' },
        ],
      });
      expect(
        await SDK_OVERRIDES['AWS::Route53::RecordSet'](
          ctx(
            { HostedZoneName: 'example.com.', Name: 'x.example.com.', Type: 'TXT' },
            'x.example.com'
          )
        )
      ).toBeUndefined();
      expect(route53.commandCalls(ListResourceRecordSetsCommand)).toHaveLength(0);
    });

    it('#1660: a declared HostedZoneId still wins — ListHostedZonesByName is not called', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          { Name: 'x.example.com.', Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"hi"' }] },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({
          HostedZoneId: 'Z1',
          HostedZoneName: 'example.com.',
          Name: 'x.example.com.',
          Type: 'TXT',
        })
      );
      expect(out).toMatchObject({ Type: 'TXT', HostedZoneId: 'Z1' });
      expect(route53.commandCalls(ListHostedZonesByNameCommand)).toHaveLength(0);
    });

    it('matches a WILDCARD record: Route53 returns `\\052.` for a declared `*.` (no false deleted)', async () => {
      // Route53 stores/returns a wildcard name in octal-escaped form. A verbatim compare
      // against the declared literal `*` misread it as absent -> a FALSE `deleted`. The
      // returned Name is also unescaped so it is not false declared drift either.
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          {
            Name: '\\052.example.com.', // AWS's escaped form of `*.example.com.`
            Type: 'A',
            AliasTarget: {
              DNSName: 'd123.cloudfront.net.',
              HostedZoneId: 'Z2FDTNDATAQYW2',
              EvaluateTargetHealth: false,
            },
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({
          HostedZoneId: 'Z1',
          Name: '*.example.com.',
          Type: 'A',
          AliasTarget: { DNSName: 'd123.cloudfront.net' },
        })
      );
      expect(out).toMatchObject({ Name: '*.example.com.', Type: 'A', HostedZoneId: 'Z1' });
    });

    it('follows IsTruncated to find a record paginated past the first page (no false deleted, WAVE23)', async () => {
      // A name+type with many SetIdentifier variants can land the declared one on page 2.
      // Reading only page 1 would throw ResourceGoneError -> a FALSE `deleted`.
      route53
        .on(ListResourceRecordSetsCommand)
        .resolvesOnce({
          ResourceRecordSets: [
            { Name: 'app.example.com.', Type: 'A', SetIdentifier: 'blue', Weight: 10 },
          ],
          IsTruncated: true,
          NextRecordName: 'app.example.com.',
          NextRecordType: 'A',
          NextRecordIdentifier: 'green',
        })
        .resolvesOnce({
          ResourceRecordSets: [
            {
              Name: 'app.example.com.',
              Type: 'A',
              SetIdentifier: 'green',
              Weight: 90,
              TTL: 60,
              ResourceRecords: [{ Value: '2.2.2.2' }],
            },
          ],
          IsTruncated: false,
        });
      const out = await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({ HostedZoneId: 'Z1', Name: 'app.example.com.', Type: 'A', SetIdentifier: 'green' })
      );
      // the page-2 record was found (NOT a false ResourceGoneError) with its routing fields
      expect(out).toMatchObject({ SetIdentifier: 'green', Weight: 90, TTL: '60' });
    });

    it('throws deleted only after exhausting all pages (a genuinely absent record)', async () => {
      route53
        .on(ListResourceRecordSetsCommand)
        .resolvesOnce({
          ResourceRecordSets: [{ Name: 'app.example.com.', Type: 'A', SetIdentifier: 'blue' }],
          IsTruncated: true,
          NextRecordName: 'app.example.com.',
          NextRecordType: 'A',
          NextRecordIdentifier: 'blue',
        })
        // page 2 moved past our name+type entirely -> exhausted, genuinely gone
        .resolvesOnce({
          ResourceRecordSets: [{ Name: 'zzz.example.com.', Type: 'A' }],
          IsTruncated: false,
        });
      await expect(
        SDK_OVERRIDES['AWS::Route53::RecordSet'](
          ctx({ HostedZoneId: 'Z1', Name: 'app.example.com.', Type: 'A', SetIdentifier: 'green' })
        )
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('disambiguates same-name+type variants by SetIdentifier (no wrong-record read) and projects routing fields', async () => {
      // Two weighted records share Name+Type; only SetIdentifier tells them apart. The
      // old reader (MaxItems:1 + Type/Name-only match) would read whichever came first
      // — here the WRONG one — reporting false drift against the declared variant.
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          {
            Name: 'app.example.com.',
            Type: 'A',
            SetIdentifier: 'blue',
            Weight: 10,
            TTL: 60,
            ResourceRecords: [{ Value: '1.1.1.1' }],
          },
          {
            Name: 'app.example.com.',
            Type: 'A',
            SetIdentifier: 'green',
            Weight: 90,
            TTL: 60,
            ResourceRecords: [{ Value: '2.2.2.2' }],
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx(
          {
            HostedZoneId: 'Z1',
            Name: 'app.example.com.',
            Type: 'A',
            SetIdentifier: 'green', // declared variant is the SECOND record
            Weight: 90,
          },
          'Z1_app.example.com._A'
        )
      );
      expect(out).toMatchObject({
        Type: 'A',
        SetIdentifier: 'green',
        Weight: 90,
        ResourceRecords: ['2.2.2.2'], // the green record's value, not blue's 1.1.1.1
      });
    });

    it('a simple record (no SetIdentifier) projects no routing fields — common-case FP guard', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [
          { Name: 'x.example.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: '"hi"' }] },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Route53::RecordSet'](
        ctx({ HostedZoneId: 'Z1', Name: 'x.example.com.', Type: 'TXT' })
      )) as Record<string, unknown>;
      expect(out.SetIdentifier).toBeUndefined();
      expect(out.Weight).toBeUndefined();
      expect(out.Failover).toBeUndefined();
      expect(out.GeoLocation).toBeUndefined();
    });
  });

  describe('Glue Table', () => {
    it('maps the live Table to the CFn TableInput shape, dropping AWS-managed fields', async () => {
      glue.on(GetTableCommand).resolves({
        Table: {
          Name: 't',
          TableType: 'EXTERNAL_TABLE',
          Parameters: { classification: 'json' },
          StorageDescriptor: { Location: 's3://b/p' },
          // AWS-managed noise that must NOT appear in the model:
          CreateTime: new Date(0),
          CreatedBy: 'arn:aws:iam::1:user/x',
          DatabaseName: 'db',
          VersionId: '1',
          IsRegisteredWithLakeFormation: false,
        },
      });
      const out = await SDK_OVERRIDES['AWS::Glue::Table'](
        ctx({ DatabaseName: 'db', TableInput: { Name: 't' } }, 'db|t')
      );
      expect(out).toEqual({
        DatabaseName: 'db',
        TableInput: {
          Name: 't',
          TableType: 'EXTERNAL_TABLE',
          Parameters: { classification: 'json' },
          StorageDescriptor: { Location: 's3://b/p' },
        },
      });
    });

    it('projects TargetTable (resource link) when present, drops it when absent', async () => {
      glue.on(GetTableCommand).resolves({
        Table: {
          Name: 't',
          TargetTable: { CatalogId: '111', DatabaseName: 'shared-db', Name: 'shared-t' },
        },
      });
      const out = (await SDK_OVERRIDES['AWS::Glue::Table'](
        ctx({ DatabaseName: 'db', TableInput: { Name: 't' } }, 'db|t')
      )) as { TableInput: Record<string, unknown> };
      expect(out.TableInput.TargetTable).toEqual({
        CatalogId: '111',
        DatabaseName: 'shared-db',
        Name: 'shared-t',
      });
    });

    it('undefined when database/table cannot be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::Glue::Table'](ctx({}))).toBeUndefined();
    });
  });

  describe('Glue Classifier', () => {
    it('projects the CSV one-of member, dropping AWS-managed + non-CFn fields (Serde/Version)', async () => {
      glue.on(GetClassifierCommand).resolves({
        Classifier: {
          CsvClassifier: {
            Name: 'c',
            Delimiter: ',',
            QuoteSymbol: '"',
            ContainsHeader: 'PRESENT',
            // non-CFn / AWS-managed noise that must NOT appear:
            Serde: 'None',
            Version: 3,
            CreationTime: new Date(0),
            LastUpdated: new Date(0),
          },
        },
      });
      const out = await SDK_OVERRIDES['AWS::Glue::Classifier'](
        ctx({ CsvClassifier: { Name: 'c', Delimiter: ',' } }, 'c')
      );
      expect(out).toEqual({
        CsvClassifier: { Name: 'c', Delimiter: ',', QuoteSymbol: '"', ContainsHeader: 'PRESENT' },
      });
    });

    it('projects the Grok one-of member (physical id = classifier name)', async () => {
      glue.on(GetClassifierCommand).resolves({
        Classifier: {
          GrokClassifier: {
            Name: 'g',
            Classification: 'syslog',
            GrokPattern: '%{GREEDYDATA:m}',
            Version: 1,
          },
        },
      });
      const out = await SDK_OVERRIDES['AWS::Glue::Classifier'](
        ctx({ GrokClassifier: { Name: 'g' } }, 'g')
      );
      expect(out).toEqual({
        GrokClassifier: { Name: 'g', Classification: 'syslog', GrokPattern: '%{GREEDYDATA:m}' },
      });
    });

    it('undefined when no classifier name can be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::Glue::Classifier'](ctx({}))).toBeUndefined();
    });
  });

  describe('Glue Workflow', () => {
    it('projects the CFn-modeled props, dropping AWS-managed run/graph state', async () => {
      glue.on(GetWorkflowCommand).resolves({
        Workflow: {
          Name: 'w',
          Description: 'etl',
          DefaultRunProperties: { env: 'test' },
          MaxConcurrentRuns: 3,
          // AWS-managed noise that must NOT appear:
          CreatedOn: new Date(0),
          LastModifiedOn: new Date(0),
          LastRun: { Name: 'w', Status: 'COMPLETED' },
          Graph: { Nodes: [] },
        },
      } as never);
      const out = await SDK_OVERRIDES['AWS::Glue::Workflow'](ctx({ Name: 'w' }, 'w'));
      expect(out).toEqual({
        Name: 'w',
        Description: 'etl',
        DefaultRunProperties: { env: 'test' },
        MaxConcurrentRuns: 3,
      });
    });

    it('omits optional props the live workflow does not set', async () => {
      glue
        .on(GetWorkflowCommand)
        .resolves({ Workflow: { Name: 'w', MaxConcurrentRuns: 1 } } as never);
      const out = await SDK_OVERRIDES['AWS::Glue::Workflow'](ctx({ Name: 'w' }, 'w'));
      expect(out).toEqual({ Name: 'w', MaxConcurrentRuns: 1 });
    });

    it('undefined when no workflow name can be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::Glue::Workflow'](ctx({}))).toBeUndefined();
    });
  });

  describe('Glue Connection', () => {
    it('projects ConnectionInput, dropping AWS-managed status/timestamps and *PASSWORD keys (keeping SECRET_ID)', async () => {
      glue.on(GetConnectionCommand).resolves({
        Connection: {
          Name: 'c',
          ConnectionType: 'JDBC',
          Description: 'etl',
          ConnectionProperties: {
            JDBC_CONNECTION_URL: 'jdbc:mysql://h:3306/db',
            JDBC_ENFORCE_SSL: 'true',
            SECRET_ID: 'arn:aws:secretsmanager:us-east-1:1:secret:s',
            PASSWORD: 'should-be-dropped',
            ENCRYPTED_PASSWORD: 'also-dropped',
          },
          // AWS-managed noise that must NOT appear:
          CreationTime: new Date(0),
          LastUpdatedTime: new Date(0),
          LastUpdatedBy: 'arn:aws:iam::1:user/x',
          Status: 'READY',
          ConnectionSchemaVersion: 1,
        },
      } as never);
      const out = (await SDK_OVERRIDES['AWS::Glue::Connection'](
        ctx({ ConnectionInput: { Name: 'c' } }, 'c')
      )) as { ConnectionInput: Record<string, unknown> };
      expect(out.ConnectionInput).toEqual({
        Name: 'c',
        ConnectionType: 'JDBC',
        Description: 'etl',
        ConnectionProperties: {
          JDBC_CONNECTION_URL: 'jdbc:mysql://h:3306/db',
          JDBC_ENFORCE_SSL: 'true',
          SECRET_ID: 'arn:aws:secretsmanager:us-east-1:1:secret:s',
        },
      });
    });

    it('reads GetConnection with HidePassword:true (no credential into the baseline)', async () => {
      glue
        .on(GetConnectionCommand)
        .resolves({ Connection: { Name: 'c', ConnectionType: 'NETWORK' } } as never);
      await SDK_OVERRIDES['AWS::Glue::Connection'](ctx({ ConnectionInput: { Name: 'c' } }, 'c'));
      const call = glue.commandCalls(GetConnectionCommand)[0]!;
      expect((call.args[0].input as { HidePassword?: boolean }).HidePassword).toBe(true);
    });

    it('undefined when no connection name can be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::Glue::Connection'](ctx({}))).toBeUndefined();
    });
  });

  describe('CloudWatch AnomalyDetector (NON_PROVISIONABLE, issue #461)', () => {
    const liveSingle = {
      SingleMetricAnomalyDetector: {
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Stat: 'Sum',
        Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
      },
      Configuration: { MetricTimezone: 'Asia/Tokyo' },
      StateValue: 'TRAINED',
    };

    it('nested single-metric style: matches by identity and mirrors the declared shape (MetricTimezone -> MetricTimeZone)', async () => {
      cloudwatch
        .on(DescribeAnomalyDetectorsCommand)
        .resolves({ AnomalyDetectors: [liveSingle] } as never);
      const out = await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
        ctx({
          SingleMetricAnomalyDetector: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
            Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
          },
        })
      );
      expect(out).toEqual({
        SingleMetricAnomalyDetector: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
          Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
        },
        Configuration: { MetricTimeZone: 'Asia/Tokyo' },
      });
      // the identity filters are pushed down to the API for single-metric detectors
      const call = cloudwatch.commandCalls(DescribeAnomalyDetectorsCommand)[0]!;
      expect(call.args[0].input).toMatchObject({ Namespace: 'AWS/Lambda', MetricName: 'Errors' });
    });

    it('legacy top-level style: emits the legacy shape the template declared', async () => {
      cloudwatch
        .on(DescribeAnomalyDetectorsCommand)
        .resolves({ AnomalyDetectors: [liveSingle] } as never);
      const out = await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
        ctx({
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
          Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
        })
      );
      expect(out).toEqual({
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Stat: 'Sum',
        Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
        Configuration: { MetricTimeZone: 'Asia/Tokyo' },
      });
    });

    it('a different Stat / dimension set does not match -> ResourceGoneError (deleted out of band)', async () => {
      cloudwatch
        .on(DescribeAnomalyDetectorsCommand)
        .resolves({ AnomalyDetectors: [liveSingle] } as never);
      await expect(
        SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
          ctx({ Namespace: 'AWS/Lambda', MetricName: 'Errors', Stat: 'Average' })
        )
      ).rejects.toThrow(/absent/);
    });

    it('unresolved identity -> undefined (skipped, never a false read)', async () => {
      expect(
        await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](ctx({ Namespace: 'AWS/Lambda' }))
      ).toBeUndefined();
    });

    it('ExcludedTimeRanges project in the CFn Range pattern (zone-less UTC — the schema rejects a trailing Z)', async () => {
      cloudwatch.on(DescribeAnomalyDetectorsCommand).resolves({
        AnomalyDetectors: [
          {
            ...liveSingle,
            Configuration: {
              MetricTimezone: 'UTC',
              ExcludedTimeRanges: [
                {
                  StartTime: new Date('2026-12-24T00:00:00Z'),
                  EndTime: new Date('2026-12-26T00:00:00Z'),
                },
              ],
            },
          },
        ],
      } as never);
      const out = (await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
        ctx({
          SingleMetricAnomalyDetector: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
            Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
          },
        })
      )) as Record<string, unknown>;
      // a declared range MUST be `YYYY-MM-DDTHH:MM:SS` (deploy rejects `Z`), so the
      // projection uses the same shape or every declared range would false-flag.
      expect(out.Configuration).toEqual({
        MetricTimeZone: 'UTC',
        ExcludedTimeRanges: [{ StartTime: '2026-12-24T00:00:00', EndTime: '2026-12-26T00:00:00' }],
      });
    });

    it('the own-account AccountId echo is projected ONLY when the template declares it', async () => {
      const withAccount = {
        ...liveSingle,
        SingleMetricAnomalyDetector: {
          ...liveSingle.SingleMetricAnomalyDetector,
          AccountId: '123456789012',
        },
      };
      cloudwatch
        .on(DescribeAnomalyDetectorsCommand)
        .resolves({ AnomalyDetectors: [withAccount] } as never);
      const decl = {
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Stat: 'Sum',
        Dimensions: [{ Name: 'FunctionName', Value: 'fn' }],
      };
      // undeclared -> suppressed (first-run noise: the API echoes the own account)
      const out = (await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
        ctx({ SingleMetricAnomalyDetector: decl })
      )) as { SingleMetricAnomalyDetector: Record<string, unknown> };
      expect(out.SingleMetricAnomalyDetector).not.toHaveProperty('AccountId');
      // declared (cross-account monitoring) -> compared like any prop
      const out2 = (await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
        ctx({ SingleMetricAnomalyDetector: { ...decl, AccountId: '123456789012' } })
      )) as { SingleMetricAnomalyDetector: Record<string, unknown> };
      expect(out2.SingleMetricAnomalyDetector.AccountId).toBe('123456789012');
    });

    it('metric-math style: lists unfiltered and matches by query-id set', async () => {
      const mathDetector = {
        MetricMathAnomalyDetector: {
          MetricDataQueries: [
            { Id: 'e1', Expression: 'SUM(METRICS())', ReturnData: true },
            { Id: 'm1', MetricStat: { Stat: 'Sum' }, ReturnData: false },
          ],
        },
        Configuration: {},
      };
      cloudwatch
        .on(DescribeAnomalyDetectorsCommand)
        .resolves({ AnomalyDetectors: [mathDetector] } as never);
      const out = (await SDK_OVERRIDES['AWS::CloudWatch::AnomalyDetector'](
        ctx({
          MetricMathAnomalyDetector: {
            MetricDataQueries: [{ Id: 'm1' }, { Id: 'e1' }],
          },
        })
      )) as Record<string, unknown>;
      expect(out.MetricMathAnomalyDetector).toEqual(mathDetector.MetricMathAnomalyDetector);
      // no Namespace/MetricName filter for math detectors — but the type MUST be
      // requested explicitly: the API defaults to SINGLE_METRIC when omitted, so an
      // unfiltered listing never returns math detectors (live-caught deleted-FP).
      const call = cloudwatch.commandCalls(DescribeAnomalyDetectorsCommand)[0]!;
      expect(call.args[0].input).toEqual({
        AnomalyDetectorTypes: ['METRIC_MATH'],
        NextToken: undefined,
      });
    });
  });

  describe('DLM LifecyclePolicy (NON_PROVISIONABLE, issue #468)', () => {
    const livePolicyDetails = {
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
    };

    it('custom style: reads GetLifecyclePolicy and emits the CFn model verbatim (id = physicalId)', async () => {
      dlm.on(GetLifecyclePolicyCommand).resolves({
        Policy: {
          PolicyId: 'policy-0abc',
          Description: 'backups',
          State: 'ENABLED',
          ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
          PolicyDetails: livePolicyDetails,
          Tags: { team: 'ops' },
        },
      } as never);
      const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](
        ctx({ PolicyDetails: livePolicyDetails }, 'policy-0abc')
      );
      expect(out).toEqual({
        Description: 'backups',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        PolicyDetails: livePolicyDetails,
        Tags: [{ Key: 'team', Value: 'ops' }],
      });
      const call = dlm.commandCalls(GetLifecyclePolicyCommand)[0]!;
      expect(call.args[0].input).toEqual({ PolicyId: 'policy-0abc' });
    });

    it('default-policy shorthand: projects the schedule knobs the API folded into PolicyDetails back to the top level', async () => {
      dlm.on(GetLifecyclePolicyCommand).resolves({
        Policy: {
          PolicyId: 'policy-0def',
          State: 'ENABLED',
          PolicyDetails: {
            PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
            PolicyLanguage: 'SIMPLIFIED',
            ResourceType: 'VOLUME',
            CreateInterval: 24,
            RetainInterval: 7,
            CopyTags: true,
          },
        },
      } as never);
      const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](
        ctx({ CreateInterval: 24, RetainInterval: 7 }, 'policy-0def')
      );
      // shorthand keys surface at the top level; the API-folded PolicyType/ResourceType do not
      expect(out).toEqual({
        State: 'ENABLED',
        CreateInterval: 24,
        RetainInterval: 7,
        CopyTags: true,
      });
    });

    it('no physical id -> undefined (skipped, never a false read)', async () => {
      expect(await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](ctx({}, ''))).toBeUndefined();
    });

    it('an empty Policy body -> ResourceGoneError (deleted out of band)', async () => {
      dlm.on(GetLifecyclePolicyCommand).resolves({} as never);
      await expect(
        SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](ctx({ PolicyDetails: {} }, 'policy-0abc'))
      ).rejects.toThrow(/absent/);
    });
  });

  describe('DMS Endpoint (NON_PROVISIONABLE, issue #497)', () => {
    it('reads DescribeEndpoints by ARN and projects the CFn-declarable scalars', async () => {
      dms.on(DescribeEndpointsCommand).resolves({
        Endpoints: [
          {
            EndpointArn: 'arn:aws:dms:us-east-1:123456789012:endpoint:ABCDEF',
            EndpointIdentifier: 'src-mysql',
            EndpointType: 'source',
            EngineName: 'mysql',
            Username: 'admin',
            ServerName: 'db.example.com',
            Port: 3306,
            DatabaseName: 'app',
            ExtraConnectionAttributes: 'initstmt=SET FOREIGN_KEY_CHECKS=0',
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
            SslMode: 'require',
            // computed/managed fields the projection must drop
            Status: 'active',
            EngineDisplayName: 'MySQL',
            S3Settings: { BucketName: 'ignored' },
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DMS::Endpoint'](
        ctx({ EngineName: 'mysql' }, 'arn:aws:dms:us-east-1:123456789012:endpoint:ABCDEF')
      );
      expect(out).toEqual({
        EndpointIdentifier: 'src-mysql',
        EndpointType: 'source',
        EngineName: 'mysql',
        Username: 'admin',
        ServerName: 'db.example.com',
        Port: 3306,
        DatabaseName: 'app',
        ExtraConnectionAttributes: 'initstmt=SET FOREIGN_KEY_CHECKS=0',
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
        SslMode: 'require',
      });
      const call = dms.commandCalls(DescribeEndpointsCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [
          {
            Name: 'endpoint-arn',
            Values: ['arn:aws:dms:us-east-1:123456789012:endpoint:ABCDEF'],
          },
        ],
      });
    });

    it('a bare (non-ARN) physical id filters on endpoint-id', async () => {
      dms.on(DescribeEndpointsCommand).resolves({
        Endpoints: [{ EndpointIdentifier: 'src-mysql', EngineName: 'mysql' }],
      } as never);
      await SDK_OVERRIDES['AWS::DMS::Endpoint'](ctx({}, 'src-mysql'));
      const call = dms.commandCalls(DescribeEndpointsCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [{ Name: 'endpoint-id', Values: ['src-mysql'] }],
      });
    });

    it('no physical id -> undefined (skipped, never a false read)', async () => {
      expect(await SDK_OVERRIDES['AWS::DMS::Endpoint'](ctx({}, ''))).toBeUndefined();
    });

    it('the endpoint is absent -> ResourceGoneError (deleted out of band)', async () => {
      dms.on(DescribeEndpointsCommand).resolves({ Endpoints: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::DMS::Endpoint'](ctx({}, 'src-mysql'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('LakeFormation Resource (CC read gap, issue #930)', () => {
    it('reads DescribeResource by ResourceArn and projects the CFn-declarable props', async () => {
      lakeformation.on(DescribeLakeFormationResourceCommand).resolves({
        ResourceInfo: {
          ResourceArn: 'arn:aws:s3:::my-datalake-bucket',
          RoleArn: 'arn:aws:iam::123456789012:role/LakeFormationRole',
          WithFederation: true,
          HybridAccessEnabled: false,
          // read-only timestamp the projection must drop (first-run noise otherwise)
          LastModified: new Date('2024-01-01T00:00:00Z'),
        },
      } as never);
      const out = await SDK_OVERRIDES['AWS::LakeFormation::Resource'](
        ctx({}, 'arn:aws:s3:::my-datalake-bucket')
      );
      expect(out).toEqual({
        ResourceArn: 'arn:aws:s3:::my-datalake-bucket',
        RoleArn: 'arn:aws:iam::123456789012:role/LakeFormationRole',
        WithFederation: true,
        HybridAccessEnabled: false,
      });
      const call = lakeformation.commandCalls(DescribeLakeFormationResourceCommand)[0]!;
      expect(call.args[0].input).toEqual({
        ResourceArn: 'arn:aws:s3:::my-datalake-bucket',
      });
    });

    it('no physical id -> undefined (skipped, never a false read)', async () => {
      expect(await SDK_OVERRIDES['AWS::LakeFormation::Resource'](ctx({}, ''))).toBeUndefined();
    });

    it('absent ResourceInfo -> ResourceGoneError (deregistered out of band)', async () => {
      lakeformation.on(DescribeLakeFormationResourceCommand).resolves({} as never);
      await expect(
        SDK_OVERRIDES['AWS::LakeFormation::Resource'](ctx({}, 'arn:aws:s3:::gone'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('EntityNotFoundException -> ResourceGoneError (deleted out of band)', async () => {
      lakeformation.on(DescribeLakeFormationResourceCommand).rejects(
        new LakeFormationEntityNotFoundException({
          message: 'not found',
          $metadata: {},
        })
      );
      await expect(
        SDK_OVERRIDES['AWS::LakeFormation::Resource'](ctx({}, 'arn:aws:s3:::gone'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('DMS ReplicationSubnetGroup (NON_PROVISIONABLE, issue #497)', () => {
    it('projects the description + flattens Subnets to a sorted SubnetIds list', async () => {
      dms.on(DescribeReplicationSubnetGroupsCommand).resolves({
        ReplicationSubnetGroups: [
          {
            ReplicationSubnetGroupIdentifier: 'dms-subnet-grp',
            ReplicationSubnetGroupDescription: 'dms subnets',
            VpcId: 'vpc-123',
            SubnetGroupStatus: 'Complete',
            Subnets: [
              { SubnetIdentifier: 'subnet-bbb', SubnetStatus: 'Active' },
              { SubnetIdentifier: 'subnet-aaa', SubnetStatus: 'Active' },
            ],
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DMS::ReplicationSubnetGroup'](
        ctx({}, 'dms-subnet-grp')
      );
      expect(out).toEqual({
        ReplicationSubnetGroupIdentifier: 'dms-subnet-grp',
        ReplicationSubnetGroupDescription: 'dms subnets',
        SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      });
      const call = dms.commandCalls(DescribeReplicationSubnetGroupsCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [{ Name: 'replication-subnet-group-id', Values: ['dms-subnet-grp'] }],
      });
    });

    it('the subnet group is absent -> ResourceGoneError (deleted out of band)', async () => {
      dms
        .on(DescribeReplicationSubnetGroupsCommand)
        .resolves({ ReplicationSubnetGroups: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::DMS::ReplicationSubnetGroup'](ctx({}, 'dms-subnet-grp'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('DMS ReplicationInstance (NON_PROVISIONABLE, issue #856)', () => {
    it('reads DescribeReplicationInstances by ARN and projects the CFn-declarable scalars', async () => {
      dms.on(DescribeReplicationInstancesCommand).resolves({
        ReplicationInstances: [
          {
            ReplicationInstanceArn: 'arn:aws:dms:us-east-1:123456789012:rep:ABCDEF',
            ReplicationInstanceIdentifier: 'my-repl',
            ReplicationInstanceClass: 'dms.t3.medium',
            AllocatedStorage: 50,
            MultiAZ: true,
            EngineVersion: '3.5.2',
            AutoMinorVersionUpgrade: true,
            PubliclyAccessible: false,
            AvailabilityZone: 'us-east-1a',
            PreferredMaintenanceWindow: 'sun:03:00-sun:03:30',
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
            ReplicationSubnetGroup: {
              ReplicationSubnetGroupIdentifier: 'dms-subnet-grp',
              VpcId: 'vpc-123',
            },
            VpcSecurityGroups: [
              { VpcSecurityGroupId: 'sg-bbb', Status: 'active' },
              { VpcSecurityGroupId: 'sg-aaa', Status: 'active' },
            ],
            // computed/managed fields the projection must drop
            ReplicationInstanceStatus: 'available',
            ReplicationInstancePrivateIpAddresses: ['10.0.0.5'],
            InstanceCreateTime: new Date(),
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DMS::ReplicationInstance'](
        ctx({}, 'arn:aws:dms:us-east-1:123456789012:rep:ABCDEF')
      );
      expect(out).toEqual({
        ReplicationInstanceIdentifier: 'my-repl',
        ReplicationInstanceClass: 'dms.t3.medium',
        AllocatedStorage: 50,
        MultiAZ: true,
        EngineVersion: '3.5.2',
        AutoMinorVersionUpgrade: true,
        PubliclyAccessible: false,
        AvailabilityZone: 'us-east-1a',
        PreferredMaintenanceWindow: 'sun:03:00-sun:03:30',
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
        ReplicationSubnetGroupIdentifier: 'dms-subnet-grp',
        // Subnet-group id flattened out of the nested API object; SGs sorted
        VpcSecurityGroupIds: ['sg-aaa', 'sg-bbb'],
      });
      const call = dms.commandCalls(DescribeReplicationInstancesCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [
          {
            Name: 'replication-instance-arn',
            Values: ['arn:aws:dms:us-east-1:123456789012:rep:ABCDEF'],
          },
        ],
      });
    });

    it('a bare (non-ARN) physical id filters on replication-instance-id', async () => {
      dms.on(DescribeReplicationInstancesCommand).resolves({
        ReplicationInstances: [{ ReplicationInstanceIdentifier: 'my-repl' }],
      } as never);
      await SDK_OVERRIDES['AWS::DMS::ReplicationInstance'](ctx({}, 'my-repl'));
      const call = dms.commandCalls(DescribeReplicationInstancesCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [{ Name: 'replication-instance-id', Values: ['my-repl'] }],
      });
    });

    it('no physical id -> undefined (skipped, never a false read)', async () => {
      expect(await SDK_OVERRIDES['AWS::DMS::ReplicationInstance'](ctx({}, ''))).toBeUndefined();
    });

    it('the instance is absent -> ResourceGoneError (deleted out of band)', async () => {
      dms.on(DescribeReplicationInstancesCommand).resolves({ ReplicationInstances: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::DMS::ReplicationInstance'](ctx({}, 'my-repl'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('DMS ReplicationTask (NON_PROVISIONABLE, issue #856)', () => {
    it('reads DescribeReplicationTasks by ARN and parses JSON-string TableMappings/ReplicationTaskSettings', async () => {
      dms.on(DescribeReplicationTasksCommand).resolves({
        ReplicationTasks: [
          {
            ReplicationTaskArn: 'arn:aws:dms:us-east-1:123456789012:task:ABCDEF',
            ReplicationTaskIdentifier: 'my-task',
            SourceEndpointArn: 'arn:aws:dms:us-east-1:123456789012:endpoint:SRC',
            TargetEndpointArn: 'arn:aws:dms:us-east-1:123456789012:endpoint:TGT',
            ReplicationInstanceArn: 'arn:aws:dms:us-east-1:123456789012:rep:ABCDEF',
            MigrationType: 'full-load',
            // the API returns these as JSON STRINGS
            TableMappings: '{"rules":[{"rule-type":"selection","rule-id":"1"}]}',
            ReplicationTaskSettings: '{"TargetMetadata":{"SupportLobs":true}}',
            CdcStartPosition: 'checkpoint:v1',
            TaskData: 'extra',
            // computed/managed fields the projection must drop
            Status: 'ready',
            LastFailureMessage: '',
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DMS::ReplicationTask'](
        ctx({}, 'arn:aws:dms:us-east-1:123456789012:task:ABCDEF')
      );
      expect(out).toEqual({
        ReplicationTaskIdentifier: 'my-task',
        SourceEndpointArn: 'arn:aws:dms:us-east-1:123456789012:endpoint:SRC',
        TargetEndpointArn: 'arn:aws:dms:us-east-1:123456789012:endpoint:TGT',
        ReplicationInstanceArn: 'arn:aws:dms:us-east-1:123456789012:rep:ABCDEF',
        MigrationType: 'full-load',
        // JSON strings normalized to objects so an object-declared side compares structurally
        TableMappings: { rules: [{ 'rule-type': 'selection', 'rule-id': '1' }] },
        ReplicationTaskSettings: { TargetMetadata: { SupportLobs: true } },
        CdcStartPosition: 'checkpoint:v1',
        TaskData: 'extra',
      });
      const call = dms.commandCalls(DescribeReplicationTasksCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [
          {
            Name: 'replication-task-arn',
            Values: ['arn:aws:dms:us-east-1:123456789012:task:ABCDEF'],
          },
        ],
      });
    });

    it('a bare (non-ARN) physical id filters on replication-task-id', async () => {
      dms.on(DescribeReplicationTasksCommand).resolves({
        ReplicationTasks: [{ ReplicationTaskIdentifier: 'my-task' }],
      } as never);
      await SDK_OVERRIDES['AWS::DMS::ReplicationTask'](ctx({}, 'my-task'));
      const call = dms.commandCalls(DescribeReplicationTasksCommand)[0]!;
      expect(call.args[0].input).toEqual({
        Filters: [{ Name: 'replication-task-id', Values: ['my-task'] }],
      });
    });

    it('an unparseable JSON-string blob falls back to the raw string', async () => {
      dms.on(DescribeReplicationTasksCommand).resolves({
        ReplicationTasks: [
          {
            ReplicationTaskIdentifier: 'my-task',
            TableMappings: 'not-json{',
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DMS::ReplicationTask'](ctx({}, 'my-task'));
      expect(out).toEqual({
        ReplicationTaskIdentifier: 'my-task',
        TableMappings: 'not-json{',
      });
    });

    it('no physical id -> undefined (skipped, never a false read)', async () => {
      expect(await SDK_OVERRIDES['AWS::DMS::ReplicationTask'](ctx({}, ''))).toBeUndefined();
    });

    it('the task is absent -> ResourceGoneError (deleted out of band)', async () => {
      dms.on(DescribeReplicationTasksCommand).resolves({ ReplicationTasks: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::DMS::ReplicationTask'](ctx({}, 'my-task'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('DMS Tags via ListTagsForResource (#1287)', () => {
    const ENDPOINT_ARN = 'arn:aws:dms:us-east-1:123456789012:endpoint:ABCDEF';

    it('Endpoint: projects live Tags from ListTagsForResource (no false declared-Tags drift)', async () => {
      dms.on(DescribeEndpointsCommand).resolves({
        Endpoints: [{ EndpointArn: ENDPOINT_ARN, EndpointIdentifier: 'src', EngineName: 'mysql' }],
      } as never);
      dms.on(DmsListTagsForResourceCommand).resolves({
        TagList: [
          { Key: 'Env', Value: 'prod' },
          { Key: 'Team', Value: 'data' },
        ],
      });
      // The template DECLARES Tags. Without projecting the live tags the model would omit Tags
      // (actual=undefined) → a false `declared`-tier drift on a tagged endpoint.
      const out = (await SDK_OVERRIDES['AWS::DMS::Endpoint'](
        ctx({ EngineName: 'mysql', Tags: [{ Key: 'Env', Value: 'prod' }] }, ENDPOINT_ARN)
      )) as Record<string, unknown>;
      expect(out.Tags).toEqual([
        { Key: 'Env', Value: 'prod' },
        { Key: 'Team', Value: 'data' },
      ]);
      // Tag call is addressed by the EndpointArn.
      const tagCall = dms.commandCalls(DmsListTagsForResourceCommand)[0]!;
      expect(tagCall.args[0].input).toEqual({ ResourceArn: ENDPOINT_ARN });
    });

    it('Endpoint: no live tags -> Tags omitted (absent stays absent, FP-safe)', async () => {
      dms.on(DescribeEndpointsCommand).resolves({
        Endpoints: [{ EndpointArn: ENDPOINT_ARN, EndpointIdentifier: 'src', EngineName: 'mysql' }],
      } as never);
      dms.on(DmsListTagsForResourceCommand).resolves({ TagList: [] });
      const out = await SDK_OVERRIDES['AWS::DMS::Endpoint'](ctx({}, ENDPOINT_ARN));
      expect(out).not.toHaveProperty('Tags');
    });

    it('Endpoint: ListTagsForResource fails -> mirrors declared Tags + warns (#1086 degrade shape)', async () => {
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      dms.on(DescribeEndpointsCommand).resolves({
        Endpoints: [{ EndpointArn: ENDPOINT_ARN, EndpointIdentifier: 'src', EngineName: 'mysql' }],
      } as never);
      dms.on(DmsListTagsForResourceCommand).rejects(new Error('AccessDenied'));
      const out = (await SDK_OVERRIDES['AWS::DMS::Endpoint'](
        ctx(
          {
            EngineName: 'mysql',
            Tags: [
              { Key: 'Env', Value: 'prod' },
              { Key: 'Team', Value: 'data' },
            ],
          },
          ENDPOINT_ARN
        )
      )) as Record<string, unknown>;
      // Degrade mirrors the DECLARED tags so the compare is equal (no false drift) …
      expect(out.Tags).toEqual([
        { Key: 'Env', Value: 'prod' },
        { Key: 'Team', Value: 'data' },
      ]);
      // … and warns on stderr so the omission is not silent.
      expect(warn.mock.calls[0]?.[0]).toContain('DMS ListTagsForResource');
      warn.mockRestore();
    });

    it('ReplicationSubnetGroup: synthesizes the subgrp ARN for the tag address', async () => {
      dms.on(DescribeReplicationSubnetGroupsCommand).resolves({
        ReplicationSubnetGroups: [{ ReplicationSubnetGroupIdentifier: 'dms-subnet-grp' }],
      } as never);
      dms.on(DmsListTagsForResourceCommand).resolves({ TagList: [{ Key: 'K', Value: 'V' }] });
      const out = (await SDK_OVERRIDES['AWS::DMS::ReplicationSubnetGroup'](
        ctx({ Tags: [{ Key: 'K', Value: 'V' }] }, 'dms-subnet-grp')
      )) as Record<string, unknown>;
      expect(out.Tags).toEqual([{ Key: 'K', Value: 'V' }]);
      const tagCall = dms.commandCalls(DmsListTagsForResourceCommand)[0]!;
      expect(tagCall.args[0].input).toEqual({
        ResourceArn: 'arn:aws:dms:us-east-1:123456789012:subgrp:dms-subnet-grp',
      });
    });

    it('ReplicationInstance: projects live Tags + present-only NetworkType/DnsNameServers', async () => {
      dms.on(DescribeReplicationInstancesCommand).resolves({
        ReplicationInstances: [
          {
            ReplicationInstanceArn: 'arn:aws:dms:us-east-1:123456789012:rep:ABCDEF',
            ReplicationInstanceIdentifier: 'my-repl',
            NetworkType: 'DUAL',
            DnsNameServers: '10.0.0.2,10.0.0.3',
          },
        ],
      } as never);
      dms.on(DmsListTagsForResourceCommand).resolves({ TagList: [{ Key: 'Env', Value: 'prod' }] });
      const out = (await SDK_OVERRIDES['AWS::DMS::ReplicationInstance'](
        ctx(
          { Tags: [{ Key: 'Env', Value: 'prod' }] },
          'arn:aws:dms:us-east-1:123456789012:rep:ABCDEF'
        )
      )) as Record<string, unknown>;
      // NetworkType (mutable) + DnsNameServers now projected → an out-of-band flip is detectable.
      expect(out.NetworkType).toBe('DUAL');
      expect(out.DnsNameServers).toBe('10.0.0.2,10.0.0.3');
      expect(out.Tags).toEqual([{ Key: 'Env', Value: 'prod' }]);
    });

    it('ReplicationInstance: NetworkType/DnsNameServers ABSENT from the response -> omitted (readGap, no fabrication)', async () => {
      dms.on(DescribeReplicationInstancesCommand).resolves({
        ReplicationInstances: [{ ReplicationInstanceIdentifier: 'my-repl' }],
      } as never);
      dms.on(DmsListTagsForResourceCommand).resolves({ TagList: [] });
      const out = await SDK_OVERRIDES['AWS::DMS::ReplicationInstance'](ctx({}, 'my-repl'));
      expect(out).not.toHaveProperty('NetworkType');
      expect(out).not.toHaveProperty('DnsNameServers');
    });

    it('ReplicationTask: projects live Tags addressed by ReplicationTaskArn', async () => {
      dms.on(DescribeReplicationTasksCommand).resolves({
        ReplicationTasks: [
          {
            ReplicationTaskArn: 'arn:aws:dms:us-east-1:123456789012:task:ABCDEF',
            ReplicationTaskIdentifier: 'my-task',
          },
        ],
      } as never);
      dms.on(DmsListTagsForResourceCommand).resolves({ TagList: [{ Key: 'K', Value: 'V' }] });
      const out = (await SDK_OVERRIDES['AWS::DMS::ReplicationTask'](
        ctx({ Tags: [{ Key: 'K', Value: 'V' }] }, 'arn:aws:dms:us-east-1:123456789012:task:ABCDEF')
      )) as Record<string, unknown>;
      expect(out.Tags).toEqual([{ Key: 'K', Value: 'V' }]);
      const tagCall = dms.commandCalls(DmsListTagsForResourceCommand)[0]!;
      expect(tagCall.args[0].input).toEqual({
        ResourceArn: 'arn:aws:dms:us-east-1:123456789012:task:ABCDEF',
      });
    });
  });

  describe('DocDB Tags via ListTagsForResource (#1287)', () => {
    it('DBCluster: projects live Tags addressed by DBClusterArn (no false declared-Tags drift)', async () => {
      docdb.on(DescribeDBClustersCommand).resolves({
        DBClusters: [
          {
            DBClusterIdentifier: 'my-cluster',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
          },
        ],
      } as never);
      docdb
        .on(DocDbListTagsForResourceCommand)
        .resolves({ TagList: [{ Key: 'Env', Value: 'prod' }] });
      const out = (await SDK_OVERRIDES['AWS::DocDB::DBCluster'](
        ctx({ Tags: [{ Key: 'Env', Value: 'prod' }] }, 'my-cluster')
      )) as Record<string, unknown>;
      expect(out.Tags).toEqual([{ Key: 'Env', Value: 'prod' }]);
      const tagCall = docdb.commandCalls(DocDbListTagsForResourceCommand)[0]!;
      expect(tagCall.args[0].input).toEqual({
        ResourceName: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
      });
    });

    it('DBCluster: no DBClusterArn on the response -> synthesizes the cluster ARN', async () => {
      docdb.on(DescribeDBClustersCommand).resolves({
        DBClusters: [{ DBClusterIdentifier: 'my-cluster' }],
      } as never);
      docdb.on(DocDbListTagsForResourceCommand).resolves({ TagList: [] });
      await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({}, 'my-cluster'));
      const tagCall = docdb.commandCalls(DocDbListTagsForResourceCommand)[0]!;
      expect(tagCall.args[0].input).toEqual({
        ResourceName: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
      });
    });

    it('DBCluster: ListTagsForResource fails -> mirrors declared Tags + warns', async () => {
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      docdb.on(DescribeDBClustersCommand).resolves({
        DBClusters: [
          {
            DBClusterIdentifier: 'my-cluster',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
          },
        ],
      } as never);
      docdb.on(DocDbListTagsForResourceCommand).rejects(new Error('AccessDenied'));
      const out = (await SDK_OVERRIDES['AWS::DocDB::DBCluster'](
        ctx({ Tags: [{ Key: 'Env', Value: 'prod' }] }, 'my-cluster')
      )) as Record<string, unknown>;
      expect(out.Tags).toEqual([{ Key: 'Env', Value: 'prod' }]);
      expect(warn.mock.calls[0]?.[0]).toContain('DocDB ListTagsForResource');
      warn.mockRestore();
    });

    it('DBInstance: projects live Tags addressed by DBInstanceArn', async () => {
      docdb.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [
          {
            DBInstanceIdentifier: 'inst-1',
            DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:inst-1',
          },
        ],
      } as never);
      docdb.on(DocDbListTagsForResourceCommand).resolves({ TagList: [{ Key: 'K', Value: 'V' }] });
      const out = (await SDK_OVERRIDES['AWS::DocDB::DBInstance'](
        ctx({ Tags: [{ Key: 'K', Value: 'V' }] }, 'inst-1')
      )) as Record<string, unknown>;
      expect(out.Tags).toEqual([{ Key: 'K', Value: 'V' }]);
      const tagCall = docdb.commandCalls(DocDbListTagsForResourceCommand)[0]!;
      expect(tagCall.args[0].input).toEqual({
        ResourceName: 'arn:aws:rds:us-east-1:123456789012:db:inst-1',
      });
    });
  });

  describe('MediaConvert Queue (NON_PROVISIONABLE, issue #497)', () => {
    it('reads GetQueue and projects Name/Description/PricingPlan/Status (drops computed fields)', async () => {
      mediaconvert.on(GetQueueCommand).resolves({
        Queue: {
          Name: 'my-queue',
          Description: 'video pipeline',
          PricingPlan: 'ON_DEMAND',
          Status: 'PAUSED',
          // computed/managed fields the projection must drop
          Arn: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/my-queue',
          Type: 'CUSTOM',
          SubmittedJobsCount: 3,
          ProgressingJobsCount: 1,
        },
      } as never);
      const out = await SDK_OVERRIDES['AWS::MediaConvert::Queue'](ctx({}, 'my-queue'));
      expect(out).toEqual({
        Name: 'my-queue',
        Description: 'video pipeline',
        PricingPlan: 'ON_DEMAND',
        Status: 'PAUSED',
      });
      const call = mediaconvert.commandCalls(GetQueueCommand)[0]!;
      expect(call.args[0].input).toEqual({ Name: 'my-queue' });
    });

    it('no physical id -> undefined (skipped, never a false read)', async () => {
      expect(await SDK_OVERRIDES['AWS::MediaConvert::Queue'](ctx({}, ''))).toBeUndefined();
    });

    it('the queue is absent -> ResourceGoneError (deleted out of band)', async () => {
      mediaconvert.on(GetQueueCommand).resolves({} as never);
      await expect(
        SDK_OVERRIDES['AWS::MediaConvert::Queue'](ctx({}, 'my-queue'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('MediaConvert JobTemplate (NON_PROVISIONABLE, issue #497)', () => {
    it('reads GetJobTemplate and passes Settings through faithfully as SettingsJson', async () => {
      const settings = {
        OutputGroups: [{ Name: 'File Group', Outputs: [{ VideoDescription: { Width: 1920 } }] }],
        TimecodeConfig: { Source: 'ZEROBASED' },
      };
      mediaconvert.on(GetJobTemplateCommand).resolves({
        JobTemplate: {
          Name: 'my-template',
          Description: 'std template',
          Category: 'archive',
          Queue: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/Default',
          Priority: 10,
          StatusUpdateInterval: 'SECONDS_60',
          AccelerationSettings: { Mode: 'DISABLED' },
          HopDestinations: [{ Priority: 5, WaitMinutes: 10 }],
          Settings: settings,
          // computed/managed fields the projection must drop
          Arn: 'arn:aws:mediaconvert:us-east-1:123456789012:jobTemplates/my-template',
          Type: 'CUSTOM',
        },
      } as never);
      const out = await SDK_OVERRIDES['AWS::MediaConvert::JobTemplate'](ctx({}, 'my-template'));
      expect(out).toEqual({
        Name: 'my-template',
        Description: 'std template',
        Category: 'archive',
        Queue: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/Default',
        Priority: 10,
        StatusUpdateInterval: 'SECONDS_60',
        AccelerationSettings: { Mode: 'DISABLED' },
        HopDestinations: [{ Priority: 5, WaitMinutes: 10 }],
        SettingsJson: settings,
      });
      const call = mediaconvert.commandCalls(GetJobTemplateCommand)[0]!;
      expect(call.args[0].input).toEqual({ Name: 'my-template' });
    });

    it('the template is absent -> ResourceGoneError (deleted out of band)', async () => {
      mediaconvert.on(GetJobTemplateCommand).resolves({} as never);
      await expect(
        SDK_OVERRIDES['AWS::MediaConvert::JobTemplate'](ctx({}, 'my-template'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('Logs MetricFilter', () => {
    it('maps camelCase SDK fields to the CFn PascalCase shape', async () => {
      logs.on(DescribeMetricFiltersCommand).resolves({
        metricFilters: [
          {
            filterName: 'errs',
            filterPattern: '?ERROR ?Error',
            metricTransformations: [
              { metricName: 'Errors', metricNamespace: 'App', metricValue: '1', defaultValue: 0 },
            ],
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::Logs::MetricFilter'](
        ctx({ LogGroupName: '/aws/lambda/fn' }, 'errs')
      );
      expect(out).toEqual({
        LogGroupName: '/aws/lambda/fn',
        FilterName: 'errs',
        FilterPattern: '?ERROR ?Error',
        MetricTransformations: [
          { MetricName: 'Errors', MetricNamespace: 'App', MetricValue: '1', DefaultValue: 0 },
        ],
      });
    });

    it('projects ApplyOnTransformedLogs when set (an out-of-band toggle is no longer invisible)', async () => {
      logs.on(DescribeMetricFiltersCommand).resolves({
        metricFilters: [
          {
            filterName: 'errs',
            filterPattern: 'ERROR',
            metricTransformations: [{ metricName: 'E', metricNamespace: 'App', metricValue: '1' }],
            applyOnTransformedLogs: true,
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Logs::MetricFilter'](
        ctx({ LogGroupName: '/lg' }, 'errs')
      )) as Record<string, unknown>;
      expect(out.ApplyOnTransformedLogs).toBe(true);
    });

    it('FP-safe: omits ApplyOnTransformedLogs when undefined; a live false folds via isTrivialEmpty', async () => {
      logs.on(DescribeMetricFiltersCommand).resolves({
        metricFilters: [
          {
            filterName: 'errs',
            filterPattern: 'ERROR',
            metricTransformations: [{ metricName: 'E', metricNamespace: 'App', metricValue: '1' }],
            // a never-set filter: AWS returns false (or omits it) — the reader projects it
            // faithfully when present; the noise layer's isTrivialEmpty drops a top-level
            // false so it is not first-run undeclared noise
            applyOnTransformedLogs: false,
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Logs::MetricFilter'](
        ctx({ LogGroupName: '/lg' }, 'errs')
      )) as Record<string, unknown>;
      expect(out.ApplyOnTransformedLogs).toBe(false);
    });

    it('projects FieldSelectionCriteria + EmitSystemFieldDimensions when set (#1332)', async () => {
      // Before the fix these two mutable, non-writeOnly CFn props were dropped: a declared
      // EmitSystemFieldDimensions read back undefined (a `declared` FP every check) and a
      // declared FieldSelectionCriteria was a permanent readGap — an out-of-band change to
      // either was silently invisible.
      logs.on(DescribeMetricFiltersCommand).resolves({
        metricFilters: [
          {
            filterName: 'errs',
            filterPattern: 'ERROR',
            metricTransformations: [{ metricName: 'E', metricNamespace: 'App', metricValue: '1' }],
            fieldSelectionCriteria: 'EventSource IN ["cloudtrail"]',
            emitSystemFieldDimensions: ['@aws.account', '@aws.region'],
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Logs::MetricFilter'](
        ctx({ LogGroupName: '/lg' }, 'errs')
      )) as Record<string, unknown>;
      expect(out.FieldSelectionCriteria).toBe('EventSource IN ["cloudtrail"]');
      expect(out.EmitSystemFieldDimensions).toEqual(['@aws.account', '@aws.region']);
    });

    it('FP-safe: omits FieldSelectionCriteria + EmitSystemFieldDimensions when unset (a never-set filter stays CLEAN) (#1332)', async () => {
      logs.on(DescribeMetricFiltersCommand).resolves({
        metricFilters: [
          {
            filterName: 'errs',
            filterPattern: 'ERROR',
            metricTransformations: [{ metricName: 'E', metricNamespace: 'App', metricValue: '1' }],
            // a never-set filter: AWS omits both — the reader must not emit undefined keys, or
            // a clean deploy surfaces first-run noise
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::Logs::MetricFilter'](
        ctx({ LogGroupName: '/lg' }, 'errs')
      )) as Record<string, unknown>;
      expect('FieldSelectionCriteria' in out).toBe(false);
      expect('EmitSystemFieldDimensions' in out).toBe(false);
    });

    it('log group described but the named filter absent -> ResourceGoneError (deleted)', async () => {
      // The log group exists and was described; the exact-named filter is gone -> deleted
      // out of band. (Was a false `undefined`/skipped that hid the deletion.)
      logs.on(DescribeMetricFiltersCommand).resolves({ metricFilters: [] });
      await expect(
        SDK_OVERRIDES['AWS::Logs::MetricFilter'](ctx({ LogGroupName: '/lg' }, 'missing'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('undefined (skipped) when the target cannot be resolved (no log group / filter name)', async () => {
      expect(await SDK_OVERRIDES['AWS::Logs::MetricFilter'](ctx({}, ''))).toBeUndefined();
    });

    it('follows nextToken to find an exact filter paginated past the first page', async () => {
      // The exact-named "errs" filter is a prefix of "errs-extra"/"errs-more", so it
      // can land on a later page. Page 1 has only prefix-siblings + a nextToken.
      logs
        .on(DescribeMetricFiltersCommand)
        .resolvesOnce({
          metricFilters: [{ filterName: 'errs-extra' }, { filterName: 'errs-more' }],
          nextToken: 'page2',
        })
        .resolvesOnce({
          metricFilters: [
            { filterName: 'errs', filterPattern: 'ERROR', metricTransformations: [] },
          ],
        });
      const out = await SDK_OVERRIDES['AWS::Logs::MetricFilter'](
        ctx({ LogGroupName: '/aws/lambda/fn' }, 'errs')
      );
      expect(out).toEqual({
        LogGroupName: '/aws/lambda/fn',
        FilterName: 'errs',
        FilterPattern: 'ERROR',
        MetricTransformations: [],
      });
    });

    it('stops at the last page (no nextToken) and reports deleted if never found', async () => {
      logs
        .on(DescribeMetricFiltersCommand)
        .resolvesOnce({ metricFilters: [{ filterName: 'errs-extra' }], nextToken: 'page2' })
        .resolvesOnce({ metricFilters: [{ filterName: 'errs-more' }] });
      // every page described, exact name never present -> deleted out of band (not skipped)
      await expect(
        SDK_OVERRIDES['AWS::Logs::MetricFilter'](ctx({ LogGroupName: '/lg' }, 'errs'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });
  });

  describe('Scheduler Schedule (R74)', () => {
    it('reads by physical-id name + declared GroupName and projects only CFn props', async () => {
      scheduler.on(GetScheduleCommand).resolves({
        Arn: 'arn:aws:scheduler:us-east-1:123456789012:schedule/grp/sched',
        Name: 'sched',
        GroupName: 'grp',
        ScheduleExpression: 'rate(1 hour)',
        FlexibleTimeWindow: { Mode: 'OFF' },
        State: 'DISABLED',
        CreationDate: new Date(0),
        LastModificationDate: new Date(0),
        Target: {
          Arn: 'arn:aws:sns:us-east-1:123456789012:t',
          RoleArn: 'arn:aws:iam::123456789012:role/r',
        },
      });
      const out = await SDK_OVERRIDES['AWS::Scheduler::Schedule'](
        ctx({ GroupName: 'grp' }, 'sched')
      );
      expect(scheduler.commandCalls(GetScheduleCommand)[0]?.args[0].input).toEqual({
        Name: 'sched',
        GroupName: 'grp',
      });
      expect(out).toEqual({
        Name: 'sched',
        GroupName: 'grp',
        ScheduleExpression: 'rate(1 hour)',
        FlexibleTimeWindow: { Mode: 'OFF' },
        State: 'DISABLED',
        Target: {
          Arn: 'arn:aws:sns:us-east-1:123456789012:t',
          RoleArn: 'arn:aws:iam::123456789012:role/r',
        },
      });
    });

    it('omits GroupName from the call when not declared (service default group)', async () => {
      scheduler.on(GetScheduleCommand).resolves({ Name: 'sched' });
      await SDK_OVERRIDES['AWS::Scheduler::Schedule'](ctx({}, 'sched'));
      expect(scheduler.commandCalls(GetScheduleCommand)[0]?.args[0].input).toEqual({
        Name: 'sched',
      });
    });

    it('undefined when no name is resolvable (-> stays skipped)', async () => {
      expect(await SDK_OVERRIDES['AWS::Scheduler::Schedule'](ctx({}))).toBeUndefined();
    });
  });

  describe('CodeBuild Project (R85)', () => {
    it('maps the camelCase SDK Project to the CFn PascalCase shape', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'cdkrd-harvest6',
            arn: 'arn:aws:codebuild:us-east-1:1:project/cdkrd-harvest6',
            serviceRole: 'arn:aws:iam::1:role/cb',
            timeoutInMinutes: 60,
            queuedTimeoutInMinutes: 480,
            source: { type: 'NO_SOURCE', buildspec: 'version: 0.2' },
            artifacts: { type: 'NO_ARTIFACTS' },
            environment: {
              type: 'LINUX_CONTAINER',
              computeType: 'BUILD_GENERAL1_SMALL',
              image: 'aws/codebuild/amazonlinux2-x86_64-standard:5.0',
              privilegedMode: false,
              environmentVariables: [{ name: 'K', value: 'V', type: 'PLAINTEXT' }],
            },
            projectVisibility: 'PRIVATE', // security-relevant — now projected
            concurrentBuildLimit: 2, // now projected
            vpcConfig: { vpcId: 'vpc-1', subnets: ['subnet-a'], securityGroupIds: ['sg-1'] },
            created: new Date(0), // AWS-managed noise — must NOT appear in the model
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'cdkrd-harvest6'));
      expect(codebuild.commandCalls(BatchGetProjectsCommand)[0]?.args[0].input).toEqual({
        names: ['cdkrd-harvest6'],
      });
      expect(out).toEqual({
        Name: 'cdkrd-harvest6',
        ServiceRole: 'arn:aws:iam::1:role/cb',
        TimeoutInMinutes: 60,
        QueuedTimeoutInMinutes: 480,
        Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2' },
        Artifacts: { Type: 'NO_ARTIFACTS' },
        Environment: {
          Type: 'LINUX_CONTAINER',
          ComputeType: 'BUILD_GENERAL1_SMALL',
          Image: 'aws/codebuild/amazonlinux2-x86_64-standard:5.0',
          PrivilegedMode: false,
          EnvironmentVariables: [{ Name: 'K', Value: 'V', Type: 'PLAINTEXT' }],
        },
        Visibility: 'PRIVATE',
        ConcurrentBuildLimit: 2,
        VpcConfig: { VpcId: 'vpc-1', Subnets: ['subnet-a'], SecurityGroupIds: ['sg-1'] },
      });
    });

    it('omits an EMPTY vpcConfig (no VPC) so a non-VPC project is not noise', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            projectVisibility: 'PRIVATE',
            vpcConfig: { vpcId: undefined, subnets: [], securityGroupIds: [] },
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(out.VpcConfig).toBeUndefined();
      expect(out.Visibility).toBe('PRIVATE');
    });

    it('projects Tags so a declared-tags project is not a false declared drift (#1056)', async () => {
      // A CDK app almost always stamps app/stack-level tags onto every Project; the reader
      // omitted `tags`, so a declared `Tags` read back `undefined` → a declared-tier FP that
      // survived record. Mirror the ReportGroup mapping ({key,value} -> {Key,Value}).
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            projectVisibility: 'PRIVATE',
            tags: [
              { key: 'cdkrd:ephemeral', value: '1' },
              { key: 'team', value: 'platform' },
            ],
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(out.Tags).toEqual([
        { Key: 'cdkrd:ephemeral', Value: '1' },
        { Key: 'team', Value: 'platform' },
      ]);
    });

    it('omits Tags for an untagged project (no empty Tags noise)', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            projectVisibility: 'PRIVATE',
            tags: [],
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(out.Tags).toBeUndefined();
    });

    it('projects LogsConfig + BadgeEnabled — an out-of-band logging/badge change is no longer invisible', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            projectVisibility: 'PRIVATE',
            logsConfig: {
              cloudWatchLogs: { status: 'ENABLED', groupName: 'g' },
              s3Logs: { status: 'DISABLED', encryptionDisabled: false },
            },
            badge: { badgeEnabled: true, badgeRequestUrl: 'https://example/badge.svg' },
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(out.LogsConfig).toEqual({
        CloudWatchLogs: { Status: 'ENABLED', GroupName: 'g' },
        S3Logs: { Status: 'DISABLED', EncryptionDisabled: false },
      });
      // badgeRequestUrl is a read-only computed URL — only the writable BadgeEnabled is projected
      expect(out.BadgeEnabled).toBe(true);
    });

    it('FP-safe absence: logsConfig=null omits LogsConfig; badgeEnabled=false stays false (isTrivialEmpty drops it)', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            projectVisibility: 'PRIVATE',
            // AWS returns logsConfig=null (not undefined) for never-configured projects;
            // the SDK models it as optional, so cast to inject the real runtime null.
            logsConfig: null as unknown as undefined,
            badge: { badgeEnabled: false },
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(out.LogsConfig).toBeUndefined();
      // the reader faithfully projects false; the noise layer's isTrivialEmpty drops a
      // never-enabled badge so it is not first-run undeclared noise
      expect(out.BadgeEnabled).toBe(false);
    });

    it('projects Source.InsecureSsl/ReportBuildStatus + Artifacts.EncryptionDisabled when set (security flags)', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: {
              type: 'GITHUB',
              location: 'https://x',
              insecureSsl: true,
              reportBuildStatus: true,
            },
            artifacts: {
              type: 'S3',
              location: 'b',
              name: 'out',
              namespaceType: 'NONE',
              packaging: 'NONE',
              encryptionDisabled: true,
            },
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(out.Source).toMatchObject({ InsecureSsl: true, ReportBuildStatus: true });
      // S3-artifact fields (Name/NamespaceType/Packaging) are now projected too — a
      // declared one no longer false-drifts as actual=undefined (live-caught in the integ)
      expect(out.Artifacts).toMatchObject({
        Name: 'out',
        NamespaceType: 'NONE',
        Packaging: 'NONE',
        EncryptionDisabled: true,
      });
    });

    it('FP-safe: the security flags are omitted when undefined; a live false folds via isTrivialEmpty', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            // a never-set project: AWS omits insecureSsl/reportBuildStatus (NO_SOURCE) and
            // returns encryptionDisabled=false on the artifacts
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS', encryptionDisabled: false },
          },
        ],
      });
      const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        Record<string, unknown>
      >;
      expect(out.Source.InsecureSsl).toBeUndefined();
      expect(out.Source.ReportBuildStatus).toBeUndefined();
      // the reader faithfully projects false; isTrivialEmpty(false) drops it from the
      // nested-undeclared compare so a never-disabled-encryption project stays CLEAN
      expect(out.Artifacts.EncryptionDisabled).toBe(false);
    });

    it('projects ResourceAccessRole + FileSystemLocations when set; omits them when absent', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            resourceAccessRole: 'arn:aws:iam::1:role/r',
            fileSystemLocations: [
              {
                type: 'EFS',
                location: 'fs-1.efs.us-east-1.amazonaws.com:/',
                mountPoint: '/mnt/efs',
                identifier: 'efs1',
                mountOptions: 'nfsvers=4.1',
              },
            ],
          },
        ],
      });
      const set = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(set.ResourceAccessRole).toBe('arn:aws:iam::1:role/r');
      expect(set.FileSystemLocations).toEqual([
        {
          Type: 'EFS',
          Location: 'fs-1.efs.us-east-1.amazonaws.com:/',
          MountPoint: '/mnt/efs',
          Identifier: 'efs1',
          MountOptions: 'nfsvers=4.1',
        },
      ]);

      // a project using neither: both omitted (no noise)
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          { name: 'p', source: { type: 'NO_SOURCE' }, artifacts: { type: 'NO_ARTIFACTS' } },
        ],
      });
      const none = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(none.ResourceAccessRole).toBeUndefined();
      expect(none.FileSystemLocations).toBeUndefined();
    });

    it('projects Cache — an out-of-band cache change is no longer invisible; NO_CACHE default folds via KNOWN_DEFAULTS', async () => {
      // a declared S3 cache projects its real shape (matches the template)
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            cache: { type: 'S3', location: 'bkt/cache', modes: ['LOCAL_SOURCE_CACHE'] },
          },
        ],
      });
      const s3 = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(s3.Cache).toEqual({
        Type: 'S3',
        Location: 'bkt/cache',
        Modes: ['LOCAL_SOURCE_CACHE'],
      });

      // the always-present NO_CACHE default projects exactly {Type:'NO_CACHE'} so it
      // folds to atDefault via KNOWN_DEFAULTS (no Location/Modes leak)
      codebuild.reset();
      codebuild.on(BatchGetProjectsCommand).resolves({
        projects: [
          {
            name: 'p',
            source: { type: 'NO_SOURCE' },
            artifacts: { type: 'NO_ARTIFACTS' },
            cache: { type: 'NO_CACHE' },
          },
        ],
      });
      const none = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
        string,
        unknown
      >;
      expect(none.Cache).toEqual({ Type: 'NO_CACHE' });
      expect(KNOWN_DEFAULTS['AWS::CodeBuild::Project'].Cache).toEqual({ Type: 'NO_CACHE' });
    });

    it('#1083: a deleted project (empty projects, name in projectsNotFound) throws ResourceGoneError → router maps to deleted (not skipped)', async () => {
      codebuild
        .on(BatchGetProjectsCommand)
        .resolves({ projects: [], projectsNotFound: ['missing'] });
      await expect(
        SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'missing'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('undefined when no name is resolvable', async () => {
      expect(await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}))).toBeUndefined();
    });
  });

  describe('CodeBuild ReportGroup (NON_PROVISIONABLE, issue #530)', () => {
    const ARN = 'arn:aws:codebuild:us-east-1:123456789012:report-group/cdkrd-reports';

    it('reads BatchGetReportGroups and projects Name/Type/ExportConfig/Tags (drops computed)', async () => {
      codebuild.on(BatchGetReportGroupsCommand).resolves({
        reportGroups: [
          {
            arn: ARN,
            name: 'cdkrd-reports',
            type: 'TEST',
            exportConfig: {
              exportConfigType: 'S3',
              s3Destination: {
                bucket: 'cdkrd-report-bucket',
                path: 'reports',
                packaging: 'ZIP',
                encryptionKey: 'arn:aws:kms:us-east-1:123456789012:key/abc',
                encryptionDisabled: false,
              },
            },
            tags: [{ key: 'team', value: 'ci' }],
            // computed/managed fields the projection must drop
            created: new Date(0),
            lastModified: new Date(0),
            status: 'ACTIVE',
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::CodeBuild::ReportGroup'](ctx({}, ARN));
      expect(out).toEqual({
        Name: 'cdkrd-reports',
        Type: 'TEST',
        ExportConfig: {
          ExportConfigType: 'S3',
          S3Destination: {
            Bucket: 'cdkrd-report-bucket',
            Path: 'reports',
            Packaging: 'ZIP',
            EncryptionKey: 'arn:aws:kms:us-east-1:123456789012:key/abc',
            EncryptionDisabled: false,
          },
        },
        Tags: [{ Key: 'team', Value: 'ci' }],
      });
    });

    it('NO_EXPORT report group: projects the ExportConfigType only, omits S3Destination/Tags', async () => {
      codebuild.on(BatchGetReportGroupsCommand).resolves({
        reportGroups: [
          {
            arn: ARN,
            name: 'cov',
            type: 'CODE_COVERAGE',
            exportConfig: { exportConfigType: 'NO_EXPORT' },
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::CodeBuild::ReportGroup'](ctx({}, ARN));
      expect(out).toEqual({
        Name: 'cov',
        Type: 'CODE_COVERAGE',
        ExportConfig: { ExportConfigType: 'NO_EXPORT' },
      });
    });

    it('a deleted report group (empty list) throws ResourceGoneError → router maps to deleted', async () => {
      codebuild.on(BatchGetReportGroupsCommand).resolves({ reportGroups: [] });
      await expect(
        SDK_OVERRIDES['AWS::CodeBuild::ReportGroup'](ctx({}, ARN))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('undefined when no ARN is resolvable', async () => {
      expect(await SDK_OVERRIDES['AWS::CodeBuild::ReportGroup'](ctx({}))).toBeUndefined();
    });
  });

  describe('ServiceDiscovery (Cloud Map CC read gap)', () => {
    it('HttpNamespace: GetNamespace by physical id, projects Name/Description + readOnly Arn/Id', async () => {
      serviceDiscovery.on(GetNamespaceCommand).resolves({
        Namespace: {
          Id: 'ns-abc',
          Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc',
          Name: 'shop',
          Description: 'the shop namespace',
          Type: 'HTTP',
          ServiceCount: 2,
          Properties: { HttpProperties: { HttpName: 'shop' } },
        },
      });
      const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::HttpNamespace'](
        ctx({ Name: 'shop' }, 'ns-abc')
      );
      expect(serviceDiscovery.commandCalls(GetNamespaceCommand)[0]?.args[0].input).toEqual({
        Id: 'ns-abc',
      });
      // Type / ServiceCount / Properties are AWS-managed noise — projected away. Arn / Id are
      // readOnly (schema-stripped from compare) but kept so an ECS ServiceConnect namespace
      // `Fn::GetAtt [<ns>, Arn]` over an HTTP namespace also resolves.
      expect(out).toEqual({
        Name: 'shop',
        Description: 'the shop namespace',
        Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc',
        Id: 'ns-abc',
      });
    });

    it('HttpNamespace: omits Description when AWS returns none', async () => {
      serviceDiscovery.on(GetNamespaceCommand).resolves({ Namespace: { Name: 'shop' } });
      const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::HttpNamespace'](
        ctx({ Name: 'shop' }, 'ns-abc')
      );
      expect(out).toEqual({ Name: 'shop' });
    });

    it('HttpNamespace: undefined when physical id is empty (-> skipped)', async () => {
      expect(
        await SDK_OVERRIDES['AWS::ServiceDiscovery::HttpNamespace'](ctx({ Name: 'shop' }))
      ).toBeUndefined();
    });

    it('PrivateDnsNamespace: projects Name/Description AND the readOnly Arn (for GetAtt resolution)', async () => {
      serviceDiscovery.on(GetNamespaceCommand).resolves({
        Namespace: {
          Id: 'ns-priv',
          Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-priv',
          Name: 'svc.internal',
          Description: 'private',
          Type: 'DNS_PRIVATE',
        },
      });
      const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::PrivateDnsNamespace'](
        ctx({ Name: 'svc.internal' }, 'ns-priv')
      );
      // Arn + Id are kept (readOnly: schema-stripped from compare, but used by an
      // Fn::GetAtt [<ns>, Arn] that an ECS ServiceConnectConfiguration.Namespace declares).
      expect(out).toEqual({
        Name: 'svc.internal',
        Description: 'private',
        Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-priv',
        Id: 'ns-priv',
      });
    });

    it('PublicDnsNamespace: same reader (Arn projected for GetAtt)', async () => {
      serviceDiscovery.on(GetNamespaceCommand).resolves({
        Namespace: { Name: 'pub.example.com', Arn: 'arn:...:namespace/ns-pub', Id: 'ns-pub' },
      });
      const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::PublicDnsNamespace'](
        ctx({ Name: 'pub.example.com' }, 'ns-pub')
      );
      expect(out).toEqual({
        Name: 'pub.example.com',
        Arn: 'arn:...:namespace/ns-pub',
        Id: 'ns-pub',
      });
    });

    it('Service: GetService by physical id, projects the CFn-modeled props', async () => {
      serviceDiscovery.on(GetServiceCommand).resolves({
        Service: {
          Id: 'srv-abc',
          Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc',
          Name: 'api',
          Description: 'the api service',
          NamespaceId: 'ns-abc',
          Type: 'HTTP',
          InstanceCount: 3,
          CreateDate: new Date(0),
        },
      });
      const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::Service'](
        ctx({ Name: 'api' }, 'srv-abc')
      );
      expect(serviceDiscovery.commandCalls(GetServiceCommand)[0]?.args[0].input).toEqual({
        Id: 'srv-abc',
      });
      // No DnsConfig / HealthCheck* for an HTTP service; Arn / InstanceCount / CreateDate dropped.
      expect(out).toEqual({
        Name: 'api',
        Description: 'the api service',
        NamespaceId: 'ns-abc',
        Type: 'HTTP',
      });
    });

    it('Service: projects DnsConfig (RoutingPolicy + DnsRecords) and HealthCheckConfig when present', async () => {
      serviceDiscovery.on(GetServiceCommand).resolves({
        Service: {
          Name: 'web',
          NamespaceId: 'ns-dns',
          DnsConfig: {
            NamespaceId: 'ns-dns', // deprecated echo — must be dropped
            RoutingPolicy: 'MULTIVALUE',
            DnsRecords: [{ Type: 'A', TTL: 60 }],
          },
          HealthCheckConfig: { Type: 'HTTP', ResourcePath: '/health', FailureThreshold: 2 },
        },
      });
      const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::Service'](
        ctx({ Name: 'web' }, 'srv-dns')
      );
      expect(out).toEqual({
        Name: 'web',
        NamespaceId: 'ns-dns',
        DnsConfig: { RoutingPolicy: 'MULTIVALUE', DnsRecords: [{ Type: 'A', TTL: 60 }] },
        HealthCheckConfig: { Type: 'HTTP', ResourcePath: '/health', FailureThreshold: 2 },
      });
    });

    it('Service: undefined when physical id is empty (-> skipped)', async () => {
      expect(
        await SDK_OVERRIDES['AWS::ServiceDiscovery::Service'](ctx({ Name: 'api' }))
      ).toBeUndefined();
    });
  });

  describe('DocumentDB (DocDB CC read gap)', () => {
    it('DBCluster: DescribeDBClusters by physical id, maps SDK names back to CFn', async () => {
      docdb.on(DescribeDBClustersCommand).resolves({
        DBClusters: [
          {
            DBClusterIdentifier: 'my-cluster',
            BackupRetentionPeriod: 3,
            Port: 27017,
            EngineVersion: '5.0.0',
            MasterUsername: 'admin',
            PreferredMaintenanceWindow: 'sun:06:00-sun:06:30',
            StorageEncrypted: true,
            DeletionProtection: false,
            EnabledCloudwatchLogsExports: ['audit'], // -> EnableCloudwatchLogsExports
            DBClusterParameterGroup: 'default.docdb5.0', // -> DBClusterParameterGroupName
            VpcSecurityGroups: [
              { VpcSecurityGroupId: 'sg-1', Status: 'active' },
              { VpcSecurityGroupId: 'sg-2', Status: 'active' },
            ],
            // noise that must be dropped:
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
            Status: 'available',
            Endpoint: 'my-cluster.cluster-xyz.docdb.amazonaws.com',
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({}, 'my-cluster'));
      expect(docdb.commandCalls(DescribeDBClustersCommand)[0]?.args[0].input).toEqual({
        DBClusterIdentifier: 'my-cluster',
      });
      expect(out).toEqual({
        DBClusterIdentifier: 'my-cluster',
        BackupRetentionPeriod: 3,
        Port: 27017,
        EngineVersion: '5.0.0',
        MasterUsername: 'admin',
        PreferredMaintenanceWindow: 'sun:06:00-sun:06:30',
        StorageEncrypted: true,
        DeletionProtection: false,
        EnableCloudwatchLogsExports: ['audit'],
        DBClusterParameterGroupName: 'default.docdb5.0',
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
      });
    });

    it('DBCluster: AvailabilityZones is NOT projected (create-only, reorder FP surface)', async () => {
      docdb.on(DescribeDBClustersCommand).resolves({
        DBClusters: [{ DBClusterIdentifier: 'c', AvailabilityZones: ['us-east-1a', 'us-east-1b'] }],
      });
      const out = await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({}, 'c'));
      expect(out).toEqual({ DBClusterIdentifier: 'c' });
    });

    it('DBCluster: falls back to declared.DBClusterIdentifier; undefined when neither resolves', async () => {
      docdb.on(DescribeDBClustersCommand).resolves({ DBClusters: [{ DBClusterIdentifier: 'd' }] });
      expect(
        await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({ DBClusterIdentifier: 'd' }))
      ).toEqual({ DBClusterIdentifier: 'd' });
      expect(await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({}))).toBeUndefined();
    });

    it('DBInstance: DescribeDBInstances by physical id, maps PerformanceInsightsEnabled', async () => {
      docdb.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [
          {
            DBInstanceIdentifier: 'inst-1',
            DBInstanceClass: 'db.t3.medium',
            DBClusterIdentifier: 'my-cluster',
            AutoMinorVersionUpgrade: true,
            PreferredMaintenanceWindow: 'mon:00:00-mon:00:30',
            CACertificateIdentifier: 'rds-ca-2019',
            PerformanceInsightsEnabled: false, // -> EnablePerformanceInsights
            // noise:
            DBInstanceStatus: 'available',
            Endpoint: { Address: 'x', Port: 27017 },
            AvailabilityZone: 'us-east-1a',
          },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::DocDB::DBInstance'](ctx({}, 'inst-1'));
      expect(out).toEqual({
        DBInstanceIdentifier: 'inst-1',
        DBInstanceClass: 'db.t3.medium',
        DBClusterIdentifier: 'my-cluster',
        AutoMinorVersionUpgrade: true,
        PreferredMaintenanceWindow: 'mon:00:00-mon:00:30',
        CACertificateIdentifier: 'rds-ca-2019',
        EnablePerformanceInsights: false,
      });
    });

    it('DBInstance: undefined when neither physical id nor declared id resolves', async () => {
      expect(await SDK_OVERRIDES['AWS::DocDB::DBInstance'](ctx({}))).toBeUndefined();
    });
  });

  describe('AppSync ApiKey (CC read gap)', () => {
    const ARN = 'arn:aws:appsync:us-east-1:123456789012:apis/abc123/apikeys/da2-xyz';
    it('parses apiId+keyId from the physical-id ARN, ListApiKeys, projects ApiId/Description/Expires', async () => {
      appsync.on(ListApiKeysCommand).resolves({
        apiKeys: [
          { id: 'da2-other', description: 'other', expires: 111 },
          { id: 'da2-xyz', description: 'the key', expires: 1784631600 },
        ],
      });
      const out = await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}, ARN));
      expect(appsync.commandCalls(ListApiKeysCommand)[0]?.args[0].input).toEqual({
        apiId: 'abc123',
      });
      expect(out).toEqual({ ApiId: 'abc123', Description: 'the key', Expires: 1784631600 });
    });

    it('omits an empty Description (a no-description key stays CLEAN)', async () => {
      appsync
        .on(ListApiKeysCommand)
        .resolves({ apiKeys: [{ id: 'da2-xyz', expires: 1784631600 }] });
      const out = await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}, ARN));
      expect(out).toEqual({ ApiId: 'abc123', Expires: 1784631600 });
    });

    it('falls back to declared.ApiId when the physical id is not an ARN', async () => {
      appsync.on(ListApiKeysCommand).resolves({ apiKeys: [{ id: 'k1', expires: 1 }] });
      const out = await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({ ApiId: 'fallback-api' }, 'k1'));
      expect(appsync.commandCalls(ListApiKeysCommand)[0]?.args[0].input).toEqual({
        apiId: 'fallback-api',
      });
      expect(out).toMatchObject({ ApiId: 'fallback-api' });
    });

    it('#965: keyId parsed from the ARN but absent from all pages -> ResourceGoneError (deleted, not skipped)', async () => {
      appsync.on(ListApiKeysCommand).resolves({ apiKeys: [{ id: 'da2-different' }] });
      await expect(SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}, ARN))).rejects.toBeInstanceOf(
        ResourceGoneError
      );
    });

    it('#965: the no-keyId best-effort branch stays undefined (not a definitive deletion)', async () => {
      // physical id is not an ARN -> no keyId to look up. An empty key list here is NOT
      // "this declared key is gone" (there was no exact id) -> undefined -> skipped.
      appsync.on(ListApiKeysCommand).resolves({ apiKeys: [] });
      expect(
        await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({ ApiId: 'fallback-api' }, 'not-an-arn'))
      ).toBeUndefined();
    });

    it('undefined when no apiId can be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}))).toBeUndefined();
    });

    it('PAGINATES ListApiKeys: finds the declared key on page 2 (nextToken loop)', async () => {
      // Page 1 carries a nextToken and NOT our key; page 2 holds da2-xyz. Reading only
      // page 1 (the pre-fix behavior) would miss it → a FALSE `skipped` for a present key.
      appsync
        .on(ListApiKeysCommand)
        .resolvesOnce({ apiKeys: [{ id: 'da2-other', expires: 111 }], nextToken: 'p2' })
        .resolvesOnce({
          apiKeys: [{ id: 'da2-xyz', description: 'the key', expires: 1784631600 }],
        });
      const out = await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}, ARN));
      expect(out).toEqual({ ApiId: 'abc123', Description: 'the key', Expires: 1784631600 });
      // Page 2 was requested with the page-1 nextToken.
      expect(appsync.commandCalls(ListApiKeysCommand)[1]?.args[0].input).toEqual({
        apiId: 'abc123',
        nextToken: 'p2',
      });
    });
  });
});

describe('EC2 NetworkAclEntry (Cloud Control read-gap: UnsupportedActionException)', () => {
  const ingress = {
    NetworkAclId: 'acl-123',
    RuleNumber: 100,
    Egress: false,
    Protocol: 6,
    RuleAction: 'allow',
    CidrBlock: '0.0.0.0/0',
    PortRange: { From: 443, To: 443 },
  };

  it('reads an ingress TCP rule by RuleNumber+Egress; coerces Protocol to a number', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-123',
          Entries: [
            // a decoy entry with the SAME RuleNumber but the OTHER direction must not match
            { RuleNumber: 100, Egress: true, Protocol: '-1', RuleAction: 'deny' },
            {
              RuleNumber: 100,
              Egress: false,
              Protocol: '6', // EC2 returns a numeric STRING
              RuleAction: 'allow',
              CidrBlock: '0.0.0.0/0',
              PortRange: { From: 443, To: 443 },
            },
          ],
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](ctx(ingress));
    expect(out).toEqual(ingress); // Protocol comes back as number 6, not "6"
  });

  it('reads an egress IPv6 ICMP rule (IcmpTypeCode -> Icmp; Ipv6CidrBlock; no PortRange)', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-ipv6',
          Entries: [
            {
              RuleNumber: 200,
              Egress: true,
              Protocol: '58',
              RuleAction: 'allow',
              Ipv6CidrBlock: '::/0',
              IcmpTypeCode: { Code: -1, Type: -1 },
            },
          ],
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](
      ctx({ NetworkAclId: 'acl-ipv6', RuleNumber: 200, Egress: true })
    );
    expect(out).toEqual({
      NetworkAclId: 'acl-ipv6',
      RuleNumber: 200,
      Egress: true,
      Protocol: 58,
      RuleAction: 'allow',
      Ipv6CidrBlock: '::/0',
      Icmp: { Code: -1, Type: -1 },
    });
    expect(out?.CidrBlock).toBeUndefined();
    expect(out?.PortRange).toBeUndefined();
  });

  it('omits PortRange + Icmp for an all-protocols rule (FP-safe)', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-all',
          Entries: [
            {
              RuleNumber: 50,
              Egress: false,
              Protocol: '-1',
              RuleAction: 'allow',
              CidrBlock: '10.0.0.0/8',
            },
          ],
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](
      ctx({ NetworkAclId: 'acl-all', RuleNumber: 50, Egress: false })
    );
    expect(out).toEqual({
      NetworkAclId: 'acl-all',
      RuleNumber: 50,
      Egress: false,
      Protocol: -1,
      RuleAction: 'allow',
      CidrBlock: '10.0.0.0/8',
    });
  });

  it('NACL present but the entry is gone -> ResourceGoneError (deleted, not skipped)', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [{ NetworkAclId: 'acl-123', Entries: [{ RuleNumber: 999, Egress: false }] }],
    });
    await expect(SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](ctx(ingress))).rejects.toBeInstanceOf(
      ResourceGoneError
    );
  });

  it('undefined (skipped) when NetworkAclId is unresolved or RuleNumber is missing', async () => {
    // unresolved NetworkAclId (str() -> undefined for a non-string / Symbol)
    expect(
      await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](ctx({ RuleNumber: 100, Egress: false }))
    ).toBeUndefined();
    // missing RuleNumber (still genuinely required identity)
    expect(
      await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](
        ctx({ NetworkAclId: 'acl-123', Egress: false })
      )
    ).toBeUndefined();
  });

  it('reads an ingress rule that OMITS the optional Egress (#1456): defaults Egress to false and matches the live Egress=false entry', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-123',
          Entries: [
            // a decoy EGRESS entry with the same RuleNumber must NOT match the
            // default-ingress lookup (Egress defaults to false)
            { RuleNumber: 100, Egress: true, Protocol: '-1', RuleAction: 'deny' },
            {
              RuleNumber: 100,
              Egress: false,
              Protocol: '-1',
              RuleAction: 'allow',
              CidrBlock: '0.0.0.0/0',
            },
          ],
        },
      ],
    });
    // NO Egress declared — the natural way to write a plain ingress rule
    const out = await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](
      ctx({
        NetworkAclId: 'acl-123',
        RuleNumber: 100,
        Protocol: -1,
        RuleAction: 'allow',
        CidrBlock: '0.0.0.0/0',
      })
    );
    expect(out).toBeDefined();
    expect(out).toEqual({
      NetworkAclId: 'acl-123',
      RuleNumber: 100,
      Egress: false,
      Protocol: -1,
      RuleAction: 'allow',
      CidrBlock: '0.0.0.0/0',
    });
  });

  it('detects an out-of-band change on an omitted-Egress ingress rule (allow -> deny reflected in the read model)', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-123',
          Entries: [
            {
              RuleNumber: 100,
              Egress: false,
              Protocol: '-1',
              RuleAction: 'deny', // flipped out of band from the declared 'allow'
              CidrBlock: '0.0.0.0/0',
            },
          ],
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](
      ctx({
        NetworkAclId: 'acl-123',
        RuleNumber: 100,
        Protocol: -1,
        RuleAction: 'allow',
        CidrBlock: '0.0.0.0/0',
      })
    );
    // the read reflects the LIVE value so the allow -> deny drift is detectable
    expect(out?.RuleAction).toBe('deny');
  });

  it('regression: an entry declaring Egress: true still reads and matches the egress entry', async () => {
    ec2.on(DescribeNetworkAclsCommand).resolves({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-eg',
          Entries: [
            // decoy ingress with same RuleNumber must not match Egress: true lookup
            { RuleNumber: 300, Egress: false, Protocol: '-1', RuleAction: 'allow' },
            {
              RuleNumber: 300,
              Egress: true,
              Protocol: '6',
              RuleAction: 'allow',
              CidrBlock: '0.0.0.0/0',
              PortRange: { From: 443, To: 443 },
            },
          ],
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::NetworkAclEntry'](
      ctx({
        NetworkAclId: 'acl-eg',
        RuleNumber: 300,
        Egress: true,
        Protocol: 6,
        RuleAction: 'allow',
        CidrBlock: '0.0.0.0/0',
        PortRange: { From: 443, To: 443 },
      })
    );
    expect(out).toEqual({
      NetworkAclId: 'acl-eg',
      RuleNumber: 300,
      Egress: true,
      Protocol: 6,
      RuleAction: 'allow',
      CidrBlock: '0.0.0.0/0',
      PortRange: { From: 443, To: 443 },
    });
  });
});

describe('SES inbound receipt-rule family (Cloud Control read-gap: no handlers)', () => {
  it('ReceiptRuleSet: projects RuleSetName from the live metadata', async () => {
    ses.on(DescribeReceiptRuleSetCommand).resolves({ Metadata: { Name: 'my-rule-set' } });
    const out = await SDK_OVERRIDES['AWS::SES::ReceiptRuleSet'](ctx({}, 'my-rule-set'));
    expect(out).toEqual({ RuleSetName: 'my-rule-set' });
  });

  it('ReceiptRuleSet: falls back to declared RuleSetName when physical id is absent', async () => {
    ses.on(DescribeReceiptRuleSetCommand).resolves({ Metadata: { Name: 'declared-set' } });
    const out = await SDK_OVERRIDES['AWS::SES::ReceiptRuleSet'](
      ctx({ RuleSetName: 'declared-set' })
    );
    expect(out).toEqual({ RuleSetName: 'declared-set' });
  });

  it('ReceiptRuleSet: undefined (skipped) when neither physical id nor declared name resolves', async () => {
    expect(await SDK_OVERRIDES['AWS::SES::ReceiptRuleSet'](ctx({}))).toBeUndefined();
  });

  it('ReceiptRule: reads the rule via its parent rule set, projecting the CFn Rule shape', async () => {
    ses.on(DescribeReceiptRuleCommand).resolves({
      Rule: {
        Name: 'my-rule',
        Enabled: true,
        TlsPolicy: 'Require',
        Recipients: ['example.com'],
        ScanEnabled: true,
        Actions: [
          { S3Action: { BucketName: 'inbox', ObjectKeyPrefix: 'mail/' } },
          { StopAction: { Scope: 'RuleSet' } },
        ],
      },
    });
    const out = await SDK_OVERRIDES['AWS::SES::ReceiptRule'](
      ctx({ RuleSetName: 'my-rule-set' }, 'my-rule')
    );
    expect(out).toEqual({
      RuleSetName: 'my-rule-set',
      Rule: {
        Name: 'my-rule',
        Enabled: true,
        TlsPolicy: 'Require',
        ScanEnabled: true,
        Recipients: ['example.com'],
        // ordered list is preserved verbatim (actions execute sequentially)
        Actions: [
          { S3Action: { BucketName: 'inbox', ObjectKeyPrefix: 'mail/' } },
          { StopAction: { Scope: 'RuleSet' } },
        ],
      },
    });
    // assert the parent rule set was passed to the describe call
    const calls = ses.commandCalls(DescribeReceiptRuleCommand);
    expect(calls[0].args[0].input).toEqual({ RuleSetName: 'my-rule-set', RuleName: 'my-rule' });
  });

  it('ReceiptRule: omits absent optional fields (empty Recipients/Actions dropped)', async () => {
    ses.on(DescribeReceiptRuleCommand).resolves({
      Rule: { Name: 'minimal', Enabled: false, ScanEnabled: false, Recipients: [], Actions: [] },
    });
    const out = await SDK_OVERRIDES['AWS::SES::ReceiptRule'](
      ctx({ RuleSetName: 'set' }, 'minimal')
    );
    expect(out).toEqual({
      RuleSetName: 'set',
      Rule: { Name: 'minimal', Enabled: false, ScanEnabled: false },
    });
  });

  it('ReceiptRule: undefined (skipped) when the parent RuleSetName is unresolved', async () => {
    expect(await SDK_OVERRIDES['AWS::SES::ReceiptRule'](ctx({}, 'orphan-rule'))).toBeUndefined();
  });

  it('ReceiptFilter: finds the named filter in the account list and projects the Filter shape', async () => {
    ses.on(ListReceiptFiltersCommand).resolves({
      Filters: [
        { Name: 'other', IpFilter: { Policy: 'Block', Cidr: '10.0.0.0/8' } },
        { Name: 'allow-office', IpFilter: { Policy: 'Allow', Cidr: '192.0.2.0/24' } },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::SES::ReceiptFilter'](ctx({}, 'allow-office'));
    expect(out).toEqual({
      Filter: { Name: 'allow-office', IpFilter: { Policy: 'Allow', Cidr: '192.0.2.0/24' } },
    });
  });

  it('ReceiptFilter: list returned but the named filter absent -> ResourceGoneError (deleted)', async () => {
    ses.on(ListReceiptFiltersCommand).resolves({
      Filters: [{ Name: 'other', IpFilter: { Policy: 'Block', Cidr: '10.0.0.0/8' } }],
    });
    await expect(
      SDK_OVERRIDES['AWS::SES::ReceiptFilter'](ctx({}, 'allow-office'))
    ).rejects.toBeInstanceOf(ResourceGoneError);
  });

  it('ReceiptFilter: undefined (skipped) when neither physical id nor declared name resolves', async () => {
    expect(await SDK_OVERRIDES['AWS::SES::ReceiptFilter'](ctx({}))).toBeUndefined();
  });
});

describe('SES ConfigurationSetEventDestination (#1643 — CC read handler broken upstream)', () => {
  const declared = {
    ConfigurationSetName: 'cs-a',
    EventDestination: {
      Name: 'dest-a',
      Enabled: true,
      MatchingEventTypes: ['DELIVERY', 'BOUNCE', 'SEND', 'COMPLAINT'],
      CloudWatchDestination: {
        DimensionConfigurations: [
          {
            DimensionName: 'ses-source',
            DimensionValueSource: 'messageTag',
            DefaultDimensionValue: 'none',
          },
        ],
      },
    },
  };

  it('reads the destination by declared name, translating the SESv2 enums to the CFn-canonical spelling', async () => {
    sesv2.on(GetConfigurationSetEventDestinationsCommand).resolves({
      EventDestinations: [
        { Name: 'other', MatchingEventTypes: ['SEND'] },
        {
          Name: 'dest-a',
          Enabled: true,
          // SESv2 returns MatchingEventTypes in UPPERCASE_SNAKE, arbitrary order — the reader
          // translates back to the CFn-canonical send/bounce/renderingFailure/deliveryDelay
          // spelling; order is immaterial (schema insertionOrder:false).
          MatchingEventTypes: ['DELIVERY', 'RENDERING_FAILURE', 'DELIVERY_DELAY', 'COMPLAINT'],
          CloudWatchDestination: {
            DimensionConfigurations: [
              {
                DimensionName: 'ses-source',
                DimensionValueSource: 'MESSAGE_TAG',
                DefaultDimensionValue: 'none',
              },
            ],
          },
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::SES::ConfigurationSetEventDestination'](
      ctx(declared, 'CsEventDest-0EsPuYMlS1rU')
    );
    expect(out).toEqual({
      ConfigurationSetName: 'cs-a',
      EventDestination: {
        Name: 'dest-a',
        Enabled: true,
        MatchingEventTypes: ['delivery', 'renderingFailure', 'deliveryDelay', 'complaint'],
        CloudWatchDestination: {
          DimensionConfigurations: [
            {
              DimensionName: 'ses-source',
              DimensionValueSource: 'messageTag',
              DefaultDimensionValue: 'none',
            },
          ],
        },
      },
    });
    // keyed on the resolved DECLARED ConfigurationSetName, not the physical id
    const calls = sesv2.commandCalls(GetConfigurationSetEventDestinationsCommand);
    expect(calls[0].args[0].input).toEqual({ ConfigurationSetName: 'cs-a' });
  });

  it('remaps the camelCased destination ARN keys to the CFn all-caps spelling', async () => {
    sesv2.on(GetConfigurationSetEventDestinationsCommand).resolves({
      EventDestinations: [
        {
          Name: 'dest-a',
          Enabled: true,
          MatchingEventTypes: ['SEND', 'SUBSCRIPTION'],
          KinesisFirehoseDestination: {
            IamRoleArn: 'arn:aws:iam::123456789012:role/fh',
            DeliveryStreamArn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/s',
          },
          SnsDestination: { TopicArn: 'arn:aws:sns:us-east-1:123456789012:t' },
          EventBridgeDestination: {
            EventBusArn: 'arn:aws:events:us-east-1:123456789012:event-bus/default',
          },
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::SES::ConfigurationSetEventDestination'](ctx(declared));
    expect(out).toEqual({
      ConfigurationSetName: 'cs-a',
      EventDestination: {
        Name: 'dest-a',
        Enabled: true,
        MatchingEventTypes: ['send', 'subscription'],
        KinesisFirehoseDestination: {
          IAMRoleARN: 'arn:aws:iam::123456789012:role/fh',
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/s',
        },
        SnsDestination: { TopicARN: 'arn:aws:sns:us-east-1:123456789012:t' },
        EventBridgeDestination: {
          EventBusArn: 'arn:aws:events:us-east-1:123456789012:event-bus/default',
        },
      },
    });
  });

  it('matches by the physical id when Name is undeclared, and OMITS the AWS-generated Name', async () => {
    // When the template declares no EventDestination.Name, CFn/SES assigns a generated
    // identifier (== the physical id). The reader MATCHES on that id but does NOT project the
    // generated Name — projecting it false-flags an undeclared drift on every clean deploy
    // (live-verified 2026-07-15). Enabled:false folds via isTrivialEmpty downstream.
    sesv2.on(GetConfigurationSetEventDestinationsCommand).resolves({
      EventDestinations: [
        { Name: 'CsEventDest-gen', Enabled: false, MatchingEventTypes: ['REJECT'] },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::SES::ConfigurationSetEventDestination'](
      ctx(
        { ConfigurationSetName: 'cs-a', EventDestination: { MatchingEventTypes: ['reject'] } },
        'CsEventDest-gen'
      )
    );
    expect(out).toEqual({
      ConfigurationSetName: 'cs-a',
      EventDestination: { Enabled: false, MatchingEventTypes: ['reject'] },
    });
  });

  it('config set exists but the named destination is absent -> ResourceGoneError (deleted)', async () => {
    sesv2.on(GetConfigurationSetEventDestinationsCommand).resolves({
      EventDestinations: [{ Name: 'other', MatchingEventTypes: ['SEND'] }],
    });
    await expect(
      SDK_OVERRIDES['AWS::SES::ConfigurationSetEventDestination'](ctx(declared, 'CsEventDest-x'))
    ).rejects.toBeInstanceOf(ResourceGoneError);
  });

  it('undefined (skipped) when the parent ConfigurationSetName is unresolved', async () => {
    expect(
      await SDK_OVERRIDES['AWS::SES::ConfigurationSetEventDestination'](
        ctx({ EventDestination: { Name: 'dest-a', MatchingEventTypes: ['SEND'] } })
      )
    ).toBeUndefined();
  });
});

describe('EC2 ClientVpn family (NON_PROVISIONABLE, issue #534)', () => {
  describe('ClientVpnEndpoint', () => {
    it('projects the CFn-declarable props (SelfServicePortal is NOT read — see below)', async () => {
      ec2.on(DescribeClientVpnEndpointsCommand).resolves({
        ClientVpnEndpoints: [
          {
            ClientVpnEndpointId: 'cvpn-endpoint-abc',
            Description: 'my vpn',
            ClientCidrBlock: '10.0.0.0/22',
            DnsServers: ['8.8.8.8'],
            SplitTunnel: true,
            TransportProtocol: 'udp',
            VpnPort: 443,
            ServerCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/srv',
            SecurityGroupIds: ['sg-123'],
            VpcId: 'vpc-123',
            SessionTimeoutHours: 12,
            DisconnectOnSessionTimeout: false,
            SelfServicePortalUrl: 'https://self-service.clientvpn.amazonaws.com/endpoints/cvpn',
            ConnectionLogOptions: {
              Enabled: true,
              CloudwatchLogGroup: '/aws/vpn',
              CloudwatchLogStream: 'conn',
            },
            AuthenticationOptions: [
              {
                Type: 'certificate-authentication',
                MutualAuthentication: { ClientRootCertificateChain: 'arn:aws:acm:...:ca' },
              },
              {
                Type: 'federated-authentication',
                FederatedAuthentication: {
                  SamlProviderArn: 'arn:aws:iam::123456789012:saml-provider/idp',
                  SelfServiceSamlProviderArn: 'arn:aws:iam::123456789012:saml-provider/self',
                },
              },
              {
                Type: 'directory-service-authentication',
                ActiveDirectory: { DirectoryId: 'd-123' },
              },
            ],
            // computed/managed fields the projection must drop
            Status: { Code: 'available' },
            CreationTime: '2026-01-01',
            DnsName: '*.cvpn.prod.clientvpn.us-east-1.amazonaws.com',
            VpnProtocol: 'openvpn',
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::EC2::ClientVpnEndpoint'](ctx({}, 'cvpn-endpoint-abc'));
      expect(out).toEqual({
        Description: 'my vpn',
        ClientCidrBlock: '10.0.0.0/22',
        DnsServers: ['8.8.8.8'],
        SplitTunnel: true,
        TransportProtocol: 'udp',
        VpnPort: 443,
        ServerCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/srv',
        SecurityGroupIds: ['sg-123'],
        VpcId: 'vpc-123',
        SessionTimeoutHours: 12,
        DisconnectOnSessionTimeout: false,
        ConnectionLogOptions: {
          Enabled: true,
          CloudwatchLogGroup: '/aws/vpn',
          CloudwatchLogStream: 'conn',
        },
        AuthenticationOptions: [
          {
            Type: 'certificate-authentication',
            MutualAuthentication: { ClientRootCertificateChainArn: 'arn:aws:acm:...:ca' },
          },
          {
            Type: 'federated-authentication',
            FederatedAuthentication: {
              SAMLProviderArn: 'arn:aws:iam::123456789012:saml-provider/idp',
              SelfServiceSAMLProviderArn: 'arn:aws:iam::123456789012:saml-provider/self',
            },
          },
          {
            Type: 'directory-service-authentication',
            ActiveDirectory: { DirectoryId: 'd-123' },
          },
        ],
      });
      const call = ec2.commandCalls(DescribeClientVpnEndpointsCommand)[0]!;
      expect(call.args[0].input).toEqual({ ClientVpnEndpointIds: ['cvpn-endpoint-abc'] });
    });

    it('SelfServicePortal is NOT projected even when a URL is returned (live: URL present when disabled too)', async () => {
      ec2.on(DescribeClientVpnEndpointsCommand).resolves({
        ClientVpnEndpoints: [
          {
            ClientVpnEndpointId: 'cvpn-endpoint-abc',
            Description: 'x',
            // AWS returns a portal URL for EVERY endpoint, enabled or not — so it is unusable.
            SelfServicePortalUrl: 'https://self-service.clientvpn.amazonaws.com/endpoints/cvpn',
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::EC2::ClientVpnEndpoint'](ctx({}, 'cvpn-endpoint-abc'));
      expect(out).toEqual({ Description: 'x' });
      expect(out).not.toHaveProperty('SelfServicePortal');
    });

    it('the endpoint is absent -> ResourceGoneError (deleted out of band)', async () => {
      ec2.on(DescribeClientVpnEndpointsCommand).resolves({ ClientVpnEndpoints: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::EC2::ClientVpnEndpoint'](ctx({}, 'cvpn-endpoint-abc'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('no physical id -> undefined (skipped)', async () => {
      expect(await SDK_OVERRIDES['AWS::EC2::ClientVpnEndpoint'](ctx({}, ''))).toBeUndefined();
    });
  });

  describe('ClientVpnAuthorizationRule', () => {
    it('matches the rule by TargetNetworkCidr + AccessGroupId and projects the CFn shape', async () => {
      ec2.on(DescribeClientVpnAuthorizationRulesCommand).resolves({
        AuthorizationRules: [
          { DestinationCidr: '10.0.0.0/16', GroupId: 'other', AccessAll: false },
          {
            DestinationCidr: '192.168.0.0/16',
            GroupId: 'grp-1',
            Description: 'admins',
            AccessAll: false,
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::EC2::ClientVpnAuthorizationRule'](
        ctx({
          ClientVpnEndpointId: 'cvpn-endpoint-abc',
          TargetNetworkCidr: '192.168.0.0/16',
          AccessGroupId: 'grp-1',
        })
      );
      expect(out).toEqual({
        ClientVpnEndpointId: 'cvpn-endpoint-abc',
        TargetNetworkCidr: '192.168.0.0/16',
        AccessGroupId: 'grp-1',
        Description: 'admins',
        AuthorizeAllGroups: false,
      });
      const call = ec2.commandCalls(DescribeClientVpnAuthorizationRulesCommand)[0]!;
      expect(call.args[0].input).toEqual({ ClientVpnEndpointId: 'cvpn-endpoint-abc' });
    });

    it('matches an all-groups rule when no AccessGroupId is declared', async () => {
      ec2.on(DescribeClientVpnAuthorizationRulesCommand).resolves({
        AuthorizationRules: [{ DestinationCidr: '0.0.0.0/0', AccessAll: true }],
      } as never);
      const out = await SDK_OVERRIDES['AWS::EC2::ClientVpnAuthorizationRule'](
        ctx({ ClientVpnEndpointId: 'cvpn-endpoint-abc', TargetNetworkCidr: '0.0.0.0/0' })
      );
      expect(out).toEqual({
        ClientVpnEndpointId: 'cvpn-endpoint-abc',
        TargetNetworkCidr: '0.0.0.0/0',
        AuthorizeAllGroups: true,
      });
    });

    it('no matching rule -> ResourceGoneError (deleted out of band)', async () => {
      ec2.on(DescribeClientVpnAuthorizationRulesCommand).resolves({
        AuthorizationRules: [{ DestinationCidr: '10.0.0.0/16' }],
      } as never);
      await expect(
        SDK_OVERRIDES['AWS::EC2::ClientVpnAuthorizationRule'](
          ctx({ ClientVpnEndpointId: 'cvpn-endpoint-abc', TargetNetworkCidr: '192.168.0.0/16' })
        )
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('no declared parent endpoint -> undefined (skipped)', async () => {
      expect(
        await SDK_OVERRIDES['AWS::EC2::ClientVpnAuthorizationRule'](
          ctx({ TargetNetworkCidr: '192.168.0.0/16' })
        )
      ).toBeUndefined();
    });

    it('PAGINATES DescribeClientVpnAuthorizationRules: matches a rule on page 2 (NextToken loop)', async () => {
      // Page 1 carries a NextToken and NOT the declared rule; page 2 holds it. Reading only
      // page 1 (the pre-fix behavior) would throw ResourceGoneError → a FALSE `deleted`.
      ec2
        .on(DescribeClientVpnAuthorizationRulesCommand)
        .resolvesOnce({
          AuthorizationRules: [{ DestinationCidr: '10.0.0.0/16', GroupId: 'other' }],
          NextToken: 'p2',
        } as never)
        .resolvesOnce({
          AuthorizationRules: [
            {
              DestinationCidr: '192.168.0.0/16',
              GroupId: 'grp-1',
              Description: 'admins',
              AccessAll: false,
            },
          ],
        } as never);
      const out = await SDK_OVERRIDES['AWS::EC2::ClientVpnAuthorizationRule'](
        ctx({
          ClientVpnEndpointId: 'cvpn-endpoint-abc',
          TargetNetworkCidr: '192.168.0.0/16',
          AccessGroupId: 'grp-1',
        })
      );
      expect(out).toEqual({
        ClientVpnEndpointId: 'cvpn-endpoint-abc',
        TargetNetworkCidr: '192.168.0.0/16',
        AccessGroupId: 'grp-1',
        Description: 'admins',
        AuthorizeAllGroups: false,
      });
      // Page 2 was requested with the page-1 NextToken.
      expect(
        ec2.commandCalls(DescribeClientVpnAuthorizationRulesCommand)[1]?.args[0].input
      ).toEqual({ ClientVpnEndpointId: 'cvpn-endpoint-abc', NextToken: 'p2' });
    });
  });

  describe('ClientVpnTargetNetworkAssociation', () => {
    it('projects ClientVpnEndpointId + SubnetId (from TargetNetworkId)', async () => {
      ec2.on(DescribeClientVpnTargetNetworksCommand).resolves({
        ClientVpnTargetNetworks: [
          {
            AssociationId: 'cvpn-assoc-123',
            ClientVpnEndpointId: 'cvpn-endpoint-abc',
            TargetNetworkId: 'subnet-123',
            Status: { Code: 'associated' },
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::EC2::ClientVpnTargetNetworkAssociation'](
        ctx({ ClientVpnEndpointId: 'cvpn-endpoint-abc' }, 'cvpn-assoc-123')
      );
      expect(out).toEqual({
        ClientVpnEndpointId: 'cvpn-endpoint-abc',
        SubnetId: 'subnet-123',
      });
      const call = ec2.commandCalls(DescribeClientVpnTargetNetworksCommand)[0]!;
      expect(call.args[0].input).toEqual({
        ClientVpnEndpointId: 'cvpn-endpoint-abc',
        AssociationIds: ['cvpn-assoc-123'],
      });
    });

    it('the association is absent -> ResourceGoneError (deleted out of band)', async () => {
      ec2
        .on(DescribeClientVpnTargetNetworksCommand)
        .resolves({ ClientVpnTargetNetworks: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::EC2::ClientVpnTargetNetworkAssociation'](
          ctx({ ClientVpnEndpointId: 'cvpn-endpoint-abc' }, 'cvpn-assoc-123')
        )
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('no declared parent endpoint -> undefined (skipped)', async () => {
      expect(
        await SDK_OVERRIDES['AWS::EC2::ClientVpnTargetNetworkAssociation'](
          ctx({}, 'cvpn-assoc-123')
        )
      ).toBeUndefined();
    });
  });
});

describe('DAX family (NON_PROVISIONABLE, issue #534)', () => {
  describe('Cluster', () => {
    it('projects the CFn-declarable props with correct casing + nested extractions', async () => {
      dax.on(DescribeClustersCommand).resolves({
        Clusters: [
          {
            ClusterName: 'my-dax',
            Description: 'cache cluster',
            NodeType: 'dax.r5.large',
            IamRoleArn: 'arn:aws:iam::123456789012:role/dax',
            PreferredMaintenanceWindow: 'sun:01:00-sun:09:00',
            SubnetGroup: 'my-subnet-grp',
            ClusterEndpointEncryptionType: 'TLS',
            SecurityGroups: [
              { SecurityGroupIdentifier: 'sg-aaa', Status: 'active' },
              { SecurityGroupIdentifier: 'sg-bbb', Status: 'active' },
            ],
            ParameterGroup: { ParameterGroupName: 'my-pg', ParameterApplyStatus: 'in-sync' },
            NotificationConfiguration: {
              TopicArn: 'arn:aws:sns:us-east-1:123456789012:dax-events',
              TopicStatus: 'active',
            },
            SSEDescription: { Status: 'ENABLED' },
            // computed/managed fields the projection must drop
            ClusterArn: 'arn:aws:dax:us-east-1:123456789012:cache/my-dax',
            TotalNodes: 3,
            ActiveNodes: 3,
            Status: 'available',
            NetworkType: 'ipv4',
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DAX::Cluster'](ctx({}, 'my-dax'));
      expect(out).toEqual({
        ClusterName: 'my-dax',
        Description: 'cache cluster',
        NodeType: 'dax.r5.large',
        IAMRoleARN: 'arn:aws:iam::123456789012:role/dax',
        PreferredMaintenanceWindow: 'sun:01:00-sun:09:00',
        SubnetGroupName: 'my-subnet-grp',
        ClusterEndpointEncryptionType: 'TLS',
        SecurityGroupIds: ['sg-aaa', 'sg-bbb'],
        ParameterGroupName: 'my-pg',
        NotificationTopicARN: 'arn:aws:sns:us-east-1:123456789012:dax-events',
        SSESpecification: { SSEEnabled: true },
      });
      const call = dax.commandCalls(DescribeClustersCommand)[0]!;
      expect(call.args[0].input).toEqual({ ClusterNames: ['my-dax'] });
    });

    it('omits SSESpecification when SSE is not ENABLED', async () => {
      dax.on(DescribeClustersCommand).resolves({
        Clusters: [{ ClusterName: 'my-dax', SSEDescription: { Status: 'DISABLED' } }],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DAX::Cluster'](ctx({}, 'my-dax'));
      expect(out).toEqual({ ClusterName: 'my-dax' });
    });

    it('the cluster is absent -> ResourceGoneError (deleted out of band)', async () => {
      dax.on(DescribeClustersCommand).resolves({ Clusters: [] } as never);
      await expect(SDK_OVERRIDES['AWS::DAX::Cluster'](ctx({}, 'my-dax'))).rejects.toBeInstanceOf(
        ResourceGoneError
      );
    });

    it('no physical id -> undefined (skipped)', async () => {
      expect(await SDK_OVERRIDES['AWS::DAX::Cluster'](ctx({}, ''))).toBeUndefined();
    });
  });

  describe('ParameterGroup', () => {
    it('projects name/description + user-settable ParameterNameValues (skips IsModifiable FALSE)', async () => {
      dax.on(DescribeParameterGroupsCommand).resolves({
        ParameterGroups: [{ ParameterGroupName: 'my-pg', Description: 'tuned' }],
      } as never);
      dax.on(DescribeDaxParametersCommand).resolves({
        Parameters: [
          { ParameterName: 'query-ttl-millis', ParameterValue: '60000', IsModifiable: 'TRUE' },
          { ParameterName: 'record-ttl-millis', ParameterValue: '30000', IsModifiable: 'TRUE' },
          // system-fixed parameter — must be skipped
          { ParameterName: 'cluster-role', ParameterValue: 'replica', IsModifiable: 'FALSE' },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DAX::ParameterGroup'](ctx({}, 'my-pg'));
      expect(out).toEqual({
        ParameterGroupName: 'my-pg',
        Description: 'tuned',
        ParameterNameValues: {
          'query-ttl-millis': '60000',
          'record-ttl-millis': '30000',
        },
      });
      const call = dax.commandCalls(DescribeDaxParametersCommand)[0]!;
      expect(call.args[0].input).toEqual({ ParameterGroupName: 'my-pg' });
    });

    it('the parameter group is absent -> ResourceGoneError (deleted out of band)', async () => {
      dax.on(DescribeParameterGroupsCommand).resolves({ ParameterGroups: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::DAX::ParameterGroup'](ctx({}, 'my-pg'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('no physical id -> undefined (skipped)', async () => {
      expect(await SDK_OVERRIDES['AWS::DAX::ParameterGroup'](ctx({}, ''))).toBeUndefined();
    });
  });

  describe('ElastiCache ParameterGroup', () => {
    it('projects name/family/description + only the source=user (modified) Properties', async () => {
      // The CC-native read returns the FULL effective set (~60 inherited engine defaults +
      // the modified ones); the SDK reader must request Source=user so only the modified
      // parameters project, matching the modified-only shape RDS returns natively.
      elasticache.on(DescribeCacheParameterGroupsCommand).resolves({
        CacheParameterGroups: [
          {
            CacheParameterGroupName: 'my-pg',
            CacheParameterGroupFamily: 'redis7',
            Description: 'tuned',
          },
        ],
      } as never);
      elasticache.on(DescribeCacheParametersCommand).resolves({
        Parameters: [
          { ParameterName: 'maxmemory-policy', ParameterValue: 'allkeys-lru', Source: 'user' },
          { ParameterName: 'timeout', ParameterValue: '300', Source: 'user' },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](ctx({}, 'my-pg'));
      expect(out).toEqual({
        CacheParameterGroupName: 'my-pg',
        CacheParameterGroupFamily: 'redis7',
        Description: 'tuned',
        Properties: { 'maxmemory-policy': 'allkeys-lru', timeout: '300' },
      });
      const call = elasticache.commandCalls(DescribeCacheParametersCommand)[0]!;
      expect(call.args[0].input).toMatchObject({
        CacheParameterGroupName: 'my-pg',
        Source: 'user',
      });
    });

    it('a group with no modified parameters projects no Properties key (all defaults fold)', async () => {
      elasticache.on(DescribeCacheParameterGroupsCommand).resolves({
        CacheParameterGroups: [
          { CacheParameterGroupName: 'my-pg', CacheParameterGroupFamily: 'redis7' },
        ],
      } as never);
      elasticache.on(DescribeCacheParametersCommand).resolves({ Parameters: [] } as never);
      const out = await SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](ctx({}, 'my-pg'));
      expect(out).toEqual({
        CacheParameterGroupName: 'my-pg',
        CacheParameterGroupFamily: 'redis7',
      });
    });

    it('paginates DescribeCacheParameters via Marker', async () => {
      elasticache.on(DescribeCacheParameterGroupsCommand).resolves({
        CacheParameterGroups: [{ CacheParameterGroupName: 'my-pg' }],
      } as never);
      elasticache
        .on(DescribeCacheParametersCommand)
        .resolvesOnce({
          Parameters: [{ ParameterName: 'timeout', ParameterValue: '300', Source: 'user' }],
          Marker: 'next',
        } as never)
        .resolvesOnce({
          Parameters: [{ ParameterName: 'databases', ParameterValue: '32', Source: 'user' }],
        } as never);
      const out = await SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](ctx({}, 'my-pg'));
      expect((out as { Properties: Record<string, string> }).Properties).toEqual({
        timeout: '300',
        databases: '32',
      });
    });

    it('the parameter group is absent -> ResourceGoneError (deleted out of band)', async () => {
      elasticache
        .on(DescribeCacheParameterGroupsCommand)
        .resolves({ CacheParameterGroups: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](ctx({}, 'my-pg'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('no physical id -> undefined (skipped)', async () => {
      expect(await SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](ctx({}, ''))).toBeUndefined();
    });
  });

  describe('SubnetGroup', () => {
    it('projects name/description + flattens Subnets to a SubnetIds list', async () => {
      dax.on(DescribeSubnetGroupsCommand).resolves({
        SubnetGroups: [
          {
            SubnetGroupName: 'my-subnet-grp',
            Description: 'dax subnets',
            VpcId: 'vpc-123',
            Subnets: [
              { SubnetIdentifier: 'subnet-aaa', SubnetAvailabilityZone: 'us-east-1a' },
              { SubnetIdentifier: 'subnet-bbb', SubnetAvailabilityZone: 'us-east-1b' },
            ],
          },
        ],
      } as never);
      const out = await SDK_OVERRIDES['AWS::DAX::SubnetGroup'](ctx({}, 'my-subnet-grp'));
      expect(out).toEqual({
        SubnetGroupName: 'my-subnet-grp',
        Description: 'dax subnets',
        SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      });
      const call = dax.commandCalls(DescribeSubnetGroupsCommand)[0]!;
      expect(call.args[0].input).toEqual({ SubnetGroupNames: ['my-subnet-grp'] });
    });

    it('the subnet group is absent -> ResourceGoneError (deleted out of band)', async () => {
      dax.on(DescribeSubnetGroupsCommand).resolves({ SubnetGroups: [] } as never);
      await expect(
        SDK_OVERRIDES['AWS::DAX::SubnetGroup'](ctx({}, 'my-subnet-grp'))
      ).rejects.toBeInstanceOf(ResourceGoneError);
    });

    it('no physical id -> undefined (skipped)', async () => {
      expect(await SDK_OVERRIDES['AWS::DAX::SubnetGroup'](ctx({}, ''))).toBeUndefined();
    });
  });
});
describe('SDK supplements', () => {
  it('ElasticBeanstalk::Environment: projects OptionSettings from DescribeConfigurationSettings', async () => {
    eb.on(DescribeConfigurationSettingsCommand).resolves({
      ConfigurationSettings: [
        {
          OptionSettings: [
            {
              Namespace: 'aws:elasticbeanstalk:cloudwatch:logs',
              OptionName: 'StreamLogs',
              Value: 'true',
            },
            { Namespace: 'aws:ec2:vpc', OptionName: 'VPCId', Value: null as unknown as string },
          ],
        },
      ],
    });
    const out = await SDK_SUPPLEMENTS['AWS::ElasticBeanstalk::Environment'](
      ctx({ ApplicationName: 'my-app' }, 'my-env')
    );
    expect(out).toEqual({
      OptionSettings: [
        {
          Namespace: 'aws:elasticbeanstalk:cloudwatch:logs',
          OptionName: 'StreamLogs',
          Value: 'true',
        },
        { Namespace: 'aws:ec2:vpc', OptionName: 'VPCId', Value: null },
      ],
    });
    const call = eb.commandCalls(DescribeConfigurationSettingsCommand)[0]!.args[0].input;
    expect(call).toEqual({ ApplicationName: 'my-app', EnvironmentName: 'my-env' });
  });

  it('ElasticBeanstalk::Environment: no ApplicationName or empty read → undefined (keep CC model)', async () => {
    expect(
      await SDK_SUPPLEMENTS['AWS::ElasticBeanstalk::Environment'](ctx({}, 'my-env'))
    ).toBeUndefined();
    eb.on(DescribeConfigurationSettingsCommand).resolves({
      ConfigurationSettings: [{ OptionSettings: [] }],
    });
    expect(
      await SDK_SUPPLEMENTS['AWS::ElasticBeanstalk::Environment'](
        ctx({ ApplicationName: 'a' }, 'e')
      )
    ).toBeUndefined();
  });

  it('Lex::Bot: reconstructs BotLocales (locale + custom slot type + intent + slot) from the lexv2-models tree walk', async () => {
    lex.on(ListBotLocalesCommand).resolves({ botLocaleSummaries: [{ localeId: 'en_US' }] });
    lex.on(DescribeBotLocaleCommand).resolves({
      localeId: 'en_US',
      description: 'cdkrd english locale',
      nluIntentConfidenceThreshold: 0.4,
    });

    // Slot types: one custom (CdkrdSize) — described fully.
    lex.on(ListSlotTypesCommand).resolves({
      slotTypeSummaries: [{ slotTypeId: 'ST_SIZE' }],
    });
    lex.on(DescribeSlotTypeCommand, { slotTypeId: 'ST_SIZE' }).resolves({
      slotTypeId: 'ST_SIZE',
      slotTypeName: 'CdkrdSize',
      description: 'sizes',
      slotTypeValues: [{ sampleValue: { value: 'small' } }, { sampleValue: { value: 'large' } }],
      // API returns the PascalCase enum; the reader maps it to CFn's SCREAMING_SNAKE (asserted below).
      valueSelectionSetting: { resolutionStrategy: 'OriginalValue' },
    });

    // Intents: one custom (CdkrdOrder) with a slot + priority.
    lex.on(ListIntentsCommand).resolves({
      intentSummaries: [{ intentId: 'I_ORDER' }],
    });
    lex.on(DescribeIntentCommand, { intentId: 'I_ORDER' }).resolves({
      intentId: 'I_ORDER',
      intentName: 'CdkrdOrder',
      description: 'order something',
      sampleUtterances: [{ utterance: 'I want a {Size} thing' }, { utterance: 'order {Size}' }],
      slotPriorities: [{ priority: 1, slotId: 'SL_SIZE' }],
    });

    lex.on(ListSlotsCommand, { intentId: 'I_ORDER' }).resolves({
      slotSummaries: [{ slotId: 'SL_SIZE' }],
    });
    lex.on(DescribeSlotCommand, { slotId: 'SL_SIZE' }).resolves({
      slotId: 'SL_SIZE',
      slotName: 'Size',
      slotTypeId: 'ST_SIZE',
      valueElicitationSetting: {
        slotConstraint: 'Required',
        promptSpecification: {
          maxRetries: 2,
          messageGroups: [{ message: { plainTextMessage: { value: 'What size?' } } }],
        },
      },
    });

    const out = await SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}, 'I3PRF2VKMG'));
    expect(out).toEqual({
      BotLocales: [
        {
          LocaleId: 'en_US',
          Description: 'cdkrd english locale',
          NluConfidenceThreshold: 0.4,
          SlotTypes: [
            {
              Name: 'CdkrdSize',
              Description: 'sizes',
              SlotTypeValues: [
                { SampleValue: { Value: 'small' } },
                { SampleValue: { Value: 'large' } },
              ],
              ValueSelectionSetting: { ResolutionStrategy: 'ORIGINAL_VALUE' },
            },
          ],
          Intents: [
            {
              Name: 'CdkrdOrder',
              Description: 'order something',
              SampleUtterances: [
                { Utterance: 'I want a {Size} thing' },
                { Utterance: 'order {Size}' },
              ],
              SlotPriorities: [{ Priority: 1, SlotName: 'Size' }],
              Slots: [
                {
                  Name: 'Size',
                  SlotTypeName: 'CdkrdSize',
                  ValueElicitationSetting: {
                    SlotConstraint: 'Required',
                    PromptSpecification: {
                      MaxRetries: 2,
                      MessageGroupsList: [
                        { Message: { PlainTextMessage: { Value: 'What size?' } } },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('Lex::Bot: skips built-in (AMAZON.*) slot types and maps a built-in slotTypeId to itself', async () => {
    lex.on(ListBotLocalesCommand).resolves({ botLocaleSummaries: [{ localeId: 'en_US' }] });
    lex.on(DescribeBotLocaleCommand).resolves({ localeId: 'en_US' });
    // A built-in slot type appears in the summary — it must NOT be described nor emitted.
    lex.on(ListSlotTypesCommand).resolves({
      slotTypeSummaries: [{ slotTypeId: 'AMAZON.Number' }],
    });
    lex.on(ListIntentsCommand).resolves({ intentSummaries: [{ intentId: 'I_ORDER' }] });
    lex.on(DescribeIntentCommand, { intentId: 'I_ORDER' }).resolves({
      intentId: 'I_ORDER',
      intentName: 'CdkrdOrder',
    });
    lex.on(ListSlotsCommand, { intentId: 'I_ORDER' }).resolves({
      slotSummaries: [{ slotId: 'SL_QTY' }],
    });
    lex.on(DescribeSlotCommand, { slotId: 'SL_QTY' }).resolves({
      slotId: 'SL_QTY',
      slotName: 'Qty',
      slotTypeId: 'AMAZON.Number',
      valueElicitationSetting: { slotConstraint: 'Optional' },
    });

    const out = await SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}, 'I3PRF2VKMG'));
    expect(out).toEqual({
      BotLocales: [
        {
          LocaleId: 'en_US',
          Intents: [
            {
              Name: 'CdkrdOrder',
              // Built-in slotTypeId resolves to itself as the SlotTypeName.
              Slots: [
                {
                  Name: 'Qty',
                  SlotTypeName: 'AMAZON.Number',
                  ValueElicitationSetting: { SlotConstraint: 'Optional' },
                },
              ],
            },
          ],
          // No SlotTypes key — the only summary was a built-in (never emitted).
        },
      ],
    });
    // The built-in slot type was never described.
    expect(lex.commandCalls(DescribeSlotTypeCommand)).toHaveLength(0);
  });

  it('Lex::Bot: PAGINATES every list call — page-2 intent AND page-2 slot both appear (nextToken loops)', async () => {
    // Two locales across two ListBotLocales pages; each list (locales/intents/slots) carries
    // a page-1 nextToken. Reading only page 1 (the pre-fix behavior) would DROP the page-2
    // locale (fr_FR), the page-2 intent (CdkrdCancel), and the page-2 slot (Qty) → a PARTIAL
    // BotLocales model (a false-confidence FN). Assert every page-2 element survives.
    lex
      .on(ListBotLocalesCommand)
      .resolvesOnce({ botLocaleSummaries: [{ localeId: 'en_US' }], nextToken: 'bl2' })
      .resolvesOnce({ botLocaleSummaries: [{ localeId: 'fr_FR' }] });
    lex.on(DescribeBotLocaleCommand).resolves({ localeId: 'x' });
    // No custom slot types (keep the fixture focused on intent/slot pagination).
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });

    // Intents paginate: I_ORDER on page 1, I_CANCEL on page 2 (both under en_US and fr_FR).
    lex
      .on(ListIntentsCommand)
      .resolvesOnce({ intentSummaries: [{ intentId: 'I_ORDER' }], nextToken: 'in2' })
      .resolvesOnce({ intentSummaries: [{ intentId: 'I_CANCEL' }] })
      .resolvesOnce({ intentSummaries: [{ intentId: 'I_ORDER' }], nextToken: 'in2' })
      .resolvesOnce({ intentSummaries: [{ intentId: 'I_CANCEL' }] });
    lex.on(DescribeIntentCommand, { intentId: 'I_ORDER' }).resolves({
      intentId: 'I_ORDER',
      intentName: 'CdkrdOrder',
    });
    lex.on(DescribeIntentCommand, { intentId: 'I_CANCEL' }).resolves({
      intentId: 'I_CANCEL',
      intentName: 'CdkrdCancel',
    });

    // Slots for I_ORDER paginate: Size on page 1, Qty on page 2. I_CANCEL has no slots.
    lex
      .on(ListSlotsCommand, { intentId: 'I_ORDER' })
      .resolvesOnce({ slotSummaries: [{ slotId: 'SL_SIZE' }], nextToken: 'sl2' })
      .resolvesOnce({ slotSummaries: [{ slotId: 'SL_QTY' }] })
      .resolvesOnce({ slotSummaries: [{ slotId: 'SL_SIZE' }], nextToken: 'sl2' })
      .resolvesOnce({ slotSummaries: [{ slotId: 'SL_QTY' }] });
    lex.on(ListSlotsCommand, { intentId: 'I_CANCEL' }).resolves({ slotSummaries: [] });
    lex
      .on(DescribeSlotCommand, { slotId: 'SL_SIZE' })
      .resolves({ slotId: 'SL_SIZE', slotName: 'Size' });
    lex
      .on(DescribeSlotCommand, { slotId: 'SL_QTY' })
      .resolves({ slotId: 'SL_QTY', slotName: 'Qty' });

    const out = (await SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}, 'I3PRF2VKMG'))) as {
      BotLocales: {
        LocaleId: string;
        Intents: { Name: string; Slots?: { Name: string }[] }[];
      }[];
    };
    // Page-2 locale (fr_FR) survived pagination.
    expect(out.BotLocales.map((l) => l.LocaleId)).toEqual(['en_US', 'fr_FR']);
    for (const loc of out.BotLocales) {
      // Page-2 intent (CdkrdCancel) survived.
      expect(loc.Intents.map((i) => i.Name)).toEqual(['CdkrdOrder', 'CdkrdCancel']);
      // Page-2 slot (Qty) survived under the paginated intent.
      const order = loc.Intents.find((i) => i.Name === 'CdkrdOrder');
      expect(order?.Slots?.map((s) => s.Name)).toEqual(['Size', 'Qty']);
    }
  });

  it('Lex::Bot: an empty botLocaleSummaries yields undefined (nothing to add)', async () => {
    lex.on(ListBotLocalesCommand).resolves({ botLocaleSummaries: [] });
    expect(await SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}, 'I3PRF2VKMG'))).toBeUndefined();
  });

  it('Lex::Bot: a lexv2 API failure PROPAGATES (throws) so the router #752 readGap degrade fires (#964)', async () => {
    // A principal missing lex:ListBotLocales (or any of the 8 read perms) makes the FIRST
    // list call reject. supplementLexBot must NOT swallow it to undefined (indistinguishable
    // from "nothing to add" at the router → BotLocales, exempted from the writeOnly strip,
    // false-flags the whole model as declared drift). It must THROW so router.ts catches it
    // and runs restoreSupplementReadGaps (+ the loud stderr warning).
    lex.on(ListBotLocalesCommand).rejects(new Error('AccessDeniedException'));
    await expect(SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}, 'I3PRF2VKMG'))).rejects.toThrow(
      'AccessDeniedException'
    );
  });

  it('Lex::Bot: a DEEP-walk failure (DescribeSlot rejects) also propagates, not a partial model (#964)', async () => {
    // A failure mid-reconstruction (here a missing lex:DescribeSlot) must also throw rather
    // than swallow to a PARTIAL/undefined model — same #752 degrade, deeper in the N+1 walk.
    lex.on(ListBotLocalesCommand).resolves({ botLocaleSummaries: [{ localeId: 'en_US' }] });
    lex.on(DescribeBotLocaleCommand).resolves({ localeId: 'en_US' });
    lex.on(ListSlotTypesCommand).resolves({ slotTypeSummaries: [] });
    lex.on(ListIntentsCommand).resolves({ intentSummaries: [{ intentId: 'I_ORDER' }] });
    lex.on(DescribeIntentCommand, { intentId: 'I_ORDER' }).resolves({
      intentId: 'I_ORDER',
      intentName: 'CdkrdOrder',
    });
    lex.on(ListSlotsCommand, { intentId: 'I_ORDER' }).resolves({
      slotSummaries: [{ slotId: 'SL_SIZE' }],
    });
    lex.on(DescribeSlotCommand, { slotId: 'SL_SIZE' }).rejects(new Error('AccessDeniedException'));
    await expect(SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}, 'I3PRF2VKMG'))).rejects.toThrow(
      'AccessDeniedException'
    );
  });

  it('Lex::Bot: undefined (skipped) when the physical id is empty', async () => {
    expect(await SDK_SUPPLEMENTS['AWS::Lex::Bot'](ctx({}))).toBeUndefined();
  });

  describe('MemoryDB::ParameterGroup', () => {
    const stubGroups = (): void => {
      memorydb.on(DescribeMemoryDbParameterGroupsCommand).resolves({
        ParameterGroups: [
          { Name: 'default.memorydb-redis7', Family: 'memorydb_redis7' },
          { Name: 'pg', Family: 'memorydb_redis7' },
        ],
      } as never);
    };
    const params = (m: Record<string, string>): never =>
      ({ Parameters: Object.entries(m).map(([Name, Value]) => ({ Name, Value })) }) as never;

    it('projects declared params (even at the family default — the CFn-never-applied case) + out-of-band-modified, folding untouched defaults', async () => {
      stubGroups();
      // The declared maxmemory-policy/timeout read back at the family DEFAULT (the MemoryDB
      // provider never applied them on create); maxmemory-samples was modified out of band;
      // activedefrag is an untouched default.
      memorydb.on(DescribeMemoryDbParametersCommand, { ParameterGroupName: 'pg' }).resolves(
        params({
          'maxmemory-policy': 'noeviction',
          timeout: '0',
          activedefrag: 'no',
          'maxmemory-samples': '10',
        })
      );
      memorydb
        .on(DescribeMemoryDbParametersCommand, { ParameterGroupName: 'default.memorydb-redis7' })
        .resolves(
          params({
            'maxmemory-policy': 'noeviction',
            timeout: '0',
            activedefrag: 'no',
            'maxmemory-samples': '3',
          })
        );
      const out = await SDK_SUPPLEMENTS['AWS::MemoryDB::ParameterGroup'](
        ctx(
          {
            ParameterGroupName: 'pg',
            Family: 'memorydb_redis7',
            Parameters: { 'maxmemory-policy': 'allkeys-lru', timeout: '300' },
          },
          'pg'
        )
      );
      // declared → always projected (surfaces the never-applied divergence); modified undeclared
      // → projected; untouched undeclared default (activedefrag) → folded.
      expect(out).toEqual({
        Parameters: { 'maxmemory-policy': 'noeviction', timeout: '0', 'maxmemory-samples': '10' },
      });
    });

    it('falls back to declared-only when the family default group cannot be resolved (no fill FP)', async () => {
      memorydb
        .on(DescribeMemoryDbParameterGroupsCommand)
        .resolves({ ParameterGroups: [] } as never);
      memorydb
        .on(DescribeMemoryDbParametersCommand, { ParameterGroupName: 'pg' })
        .resolves(
          params({ 'maxmemory-policy': 'allkeys-lru', timeout: '300', activedefrag: 'no' })
        );
      const out = await SDK_SUPPLEMENTS['AWS::MemoryDB::ParameterGroup'](
        ctx(
          {
            ParameterGroupName: 'pg',
            Family: 'memorydb_redis7',
            Parameters: { 'maxmemory-policy': 'allkeys-lru', timeout: '300' },
          },
          'pg'
        )
      );
      // Without defaults, only the declared params project — the undeclared `activedefrag` is NOT
      // surfaced (never a full-effective-set fill FP).
      expect(out).toEqual({ Parameters: { 'maxmemory-policy': 'allkeys-lru', timeout: '300' } });
    });

    it('undefined when the group has no readable parameters', async () => {
      memorydb.on(DescribeMemoryDbParametersCommand).resolves({ Parameters: [] } as never);
      expect(
        await SDK_SUPPLEMENTS['AWS::MemoryDB::ParameterGroup'](
          ctx({ ParameterGroupName: 'pg', Family: 'memorydb_redis7' }, 'pg')
        )
      ).toBeUndefined();
    });

    it('undefined (skipped) when no name is resolvable', async () => {
      expect(await SDK_SUPPLEMENTS['AWS::MemoryDB::ParameterGroup'](ctx({}))).toBeUndefined();
    });
  });
});

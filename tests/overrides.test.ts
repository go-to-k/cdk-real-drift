import { AppSyncClient, ListApiKeysCommand } from '@aws-sdk/client-appsync';
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { BatchGetProjectsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DocDBClient,
} from '@aws-sdk/client-docdb';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
} from '@aws-sdk/client-cloudwatch-logs';
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
  ListEntitiesForPolicyCommand,
} from '@aws-sdk/client-iam';
import { ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from '@aws-sdk/client-lambda';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  GetNamespaceCommand,
  GetServiceCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
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
  ])
    m.reset();
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

    it('undefined when the project is absent (-> stays skipped)', async () => {
      codebuild.on(BatchGetProjectsCommand).resolves({ projects: [] });
      expect(await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'missing'))).toBeUndefined();
    });

    it('undefined when no name is resolvable', async () => {
      expect(await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}))).toBeUndefined();
    });
  });

  describe('ServiceDiscovery (Cloud Map CC read gap)', () => {
    it('HttpNamespace: GetNamespace by physical id, projects Name + Description only', async () => {
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
      // Arn / Id / Type / ServiceCount / Properties are AWS-managed noise — projected away.
      expect(out).toEqual({ Name: 'shop', Description: 'the shop namespace' });
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

    it('undefined when the keyed key is absent (deleted out of band -> skipped)', async () => {
      appsync.on(ListApiKeysCommand).resolves({ apiKeys: [{ id: 'da2-different' }] });
      expect(await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}, ARN))).toBeUndefined();
    });

    it('undefined when no apiId can be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::AppSync::ApiKey'](ctx({}))).toBeUndefined();
    });
  });
});

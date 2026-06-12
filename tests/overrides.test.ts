import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { GetTableCommand, GlueClient } from '@aws-sdk/client-glue';
import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  IAMClient,
} from '@aws-sdk/client-iam';
import { ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from '@aws-sdk/client-lambda';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const s3 = mockClient(S3Client);
const sns = mockClient(SNSClient);
const sqs = mockClient(SQSClient);
const iam = mockClient(IAMClient);
const lambda = mockClient(LambdaClient);
const budgets = mockClient(BudgetsClient);
const route53 = mockClient(Route53Client);
const glue = mockClient(GlueClient);
const logs = mockClient(CloudWatchLogsClient);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});
const POLICY =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:Get","Resource":"*"}]}';

beforeEach(() => {
  for (const m of [s3, sns, sqs, iam, lambda, budgets, route53, glue, logs]) m.reset();
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

  it('Budgets: reads the budget by name + account, projecting BudgetLimit (R67)', async () => {
    budgets.on(DescribeBudgetCommand).resolves({
      Budget: {
        BudgetName: 'b',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: '40.0', Unit: 'USD' },
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

    it('undefined when no record matches (-> stays skipped, no false drift)', async () => {
      route53.on(ListResourceRecordSetsCommand).resolves({
        ResourceRecordSets: [{ Name: 'other.example.com.', Type: 'A' }],
      });
      expect(
        await SDK_OVERRIDES['AWS::Route53::RecordSet'](
          ctx({ HostedZoneId: 'Z1', Name: 'app.example.com.', Type: 'A' })
        )
      ).toBeUndefined();
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

    it('undefined when database/table cannot be resolved', async () => {
      expect(await SDK_OVERRIDES['AWS::Glue::Table'](ctx({}))).toBeUndefined();
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

    it('undefined when the named filter is absent (-> stays skipped)', async () => {
      logs.on(DescribeMetricFiltersCommand).resolves({ metricFilters: [] });
      expect(
        await SDK_OVERRIDES['AWS::Logs::MetricFilter'](ctx({ LogGroupName: '/lg' }, 'missing'))
      ).toBeUndefined();
    });
  });
});

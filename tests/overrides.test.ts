import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  IAMClient,
} from '@aws-sdk/client-iam';
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

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});
const POLICY =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:Get","Resource":"*"}]}';

beforeEach(() => {
  for (const m of [s3, sns, sqs, iam, lambda, budgets]) m.reset();
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

  it('Budgets: reads the budget by name + account', async () => {
    budgets
      .on(DescribeBudgetCommand)
      .resolves({ Budget: { BudgetName: 'b', BudgetType: 'COST', TimeUnit: 'MONTHLY' } });
    const out = await SDK_OVERRIDES['AWS::Budgets::Budget'](ctx({ Budget: { BudgetName: 'b' } }));
    expect(out).toEqual({ Budget: { BudgetName: 'b', BudgetType: 'COST', TimeUnit: 'MONTHLY' } });
  });
  it('Budgets: undefined without a budget name', async () => {
    expect(await SDK_OVERRIDES['AWS::Budgets::Budget'](ctx({ Budget: {} }))).toBeUndefined();
  });
});

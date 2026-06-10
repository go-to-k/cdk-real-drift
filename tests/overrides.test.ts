import { BudgetsClient, DescribeBudgetCommand } from "@aws-sdk/client-budgets";
import { GetPolicyCommand, GetPolicyVersionCommand, GetRolePolicyCommand, IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from "@aws-sdk/client-lambda";
import { GetBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { GetTopicAttributesCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { SDK_OVERRIDES } from "../src/read/overrides.js";

const s3 = mockClient(S3Client);
const sns = mockClient(SNSClient);
const sqs = mockClient(SQSClient);
const iam = mockClient(IAMClient);
const lambda = mockClient(LambdaClient);
const budgets = mockClient(BudgetsClient);

const ctx = (declared: Record<string, unknown>, physicalId = "", accountId = "123456789012") => ({
  physicalId,
  declared,
  region: "us-east-1",
  accountId,
});
const POLICY = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:Get","Resource":"*"}]}';

beforeEach(() => {
  for (const m of [s3, sns, sqs, iam, lambda, budgets]) m.reset();
});

describe("SDK overrides", () => {
  it("S3 BucketPolicy: reads + parses PolicyDocument", async () => {
    s3.on(GetBucketPolicyCommand).resolves({ Policy: POLICY });
    const out = await SDK_OVERRIDES["AWS::S3::BucketPolicy"](ctx({ Bucket: "my-bucket" }));
    expect(out).toEqual({ Bucket: "my-bucket", PolicyDocument: JSON.parse(POLICY) });
  });
  it("S3 BucketPolicy: undefined when Bucket unresolved", async () => {
    expect(await SDK_OVERRIDES["AWS::S3::BucketPolicy"](ctx({}))).toBeUndefined();
  });

  it("SNS TopicPolicy: reads Policy attribute", async () => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: POLICY } });
    const out = await SDK_OVERRIDES["AWS::SNS::TopicPolicy"](ctx({ Topics: ["arn:aws:sns:us-east-1:1:t"] }));
    expect(out).toMatchObject({ PolicyDocument: JSON.parse(POLICY) });
  });

  it("SQS QueuePolicy: reads Policy attribute", async () => {
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: POLICY } });
    const out = await SDK_OVERRIDES["AWS::SQS::QueuePolicy"](ctx({ Queues: ["https://sqs/q"] }));
    expect(out).toMatchObject({ PolicyDocument: JSON.parse(POLICY) });
  });

  it("IAM Policy: reads inline role policy (URL-decoded)", async () => {
    iam.on(GetRolePolicyCommand).resolves({ PolicyDocument: encodeURIComponent(POLICY) });
    const out = await SDK_OVERRIDES["AWS::IAM::Policy"](ctx({ PolicyName: "p", Roles: ["r"] }));
    expect(out).toMatchObject({ PolicyName: "p", PolicyDocument: JSON.parse(POLICY), Roles: ["r"] });
  });

  it("IAM ManagedPolicy: reads default version document by ARN", async () => {
    iam.on(GetPolicyCommand).resolves({ Policy: { DefaultVersionId: "v2", Path: "/", Description: "d" } });
    iam.on(GetPolicyVersionCommand).resolves({ PolicyVersion: { Document: encodeURIComponent(POLICY) } });
    const out = await SDK_OVERRIDES["AWS::IAM::ManagedPolicy"](ctx({}, "arn:aws:iam::123:policy/p"));
    expect(out).toMatchObject({ PolicyDocument: JSON.parse(POLICY), Path: "/", Description: "d" });
  });
  it("IAM ManagedPolicy: undefined when physical id is not an ARN", async () => {
    expect(await SDK_OVERRIDES["AWS::IAM::ManagedPolicy"](ctx({}, "not-an-arn"))).toBeUndefined();
  });

  it("Lambda Permission: matches statement by Action + Principal", async () => {
    const fnPolicy = JSON.stringify({
      Statement: [{ Sid: "x", Action: "lambda:InvokeFunction", Principal: { Service: "s3.amazonaws.com" } }],
    });
    lambda.on(LambdaGetPolicyCommand).resolves({ Policy: fnPolicy });
    const out = await SDK_OVERRIDES["AWS::Lambda::Permission"](
      ctx({ FunctionName: "f", Action: "lambda:InvokeFunction", Principal: "s3.amazonaws.com" }),
    );
    expect(out).toMatchObject({ FunctionName: "f", Action: "lambda:InvokeFunction" });
  });

  it("Budgets: reads the budget by name + account", async () => {
    budgets.on(DescribeBudgetCommand).resolves({ Budget: { BudgetName: "b", BudgetType: "COST", TimeUnit: "MONTHLY" } });
    const out = await SDK_OVERRIDES["AWS::Budgets::Budget"](ctx({ Budget: { BudgetName: "b" } }));
    expect(out).toEqual({ Budget: { BudgetName: "b", BudgetType: "COST", TimeUnit: "MONTHLY" } });
  });
  it("Budgets: undefined without a budget name", async () => {
    expect(await SDK_OVERRIDES["AWS::Budgets::Budget"](ctx({ Budget: {} }))).toBeUndefined();
  });
});

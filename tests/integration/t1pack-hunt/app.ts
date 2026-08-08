// CDK app for the cdk-real-drift t1pack-hunt integration test (2026-08-09 hunt).
// Barest deploys of eight free/instant, genuinely-unexercised surfaces (offline
// audit 2026-08-09) — each probes a first-run fold / read surface no fixture or
// corpus case has ever exercised:
//   - Step Functions STANDARD state machine whose definition uses
//     QueryLanguage=JSONata + a DISTRIBUTED Map (ItemProcessor.ProcessorConfig) —
//     JSON-in-string definition echo where the service may inject per-state or
//     processor defaults into the stored definition
//   - Lambda Function URL InvokeMode=RESPONSE_STREAM (corpus has only BUFFERED)
//     with Cors undeclared (service-fill probe)
//   - DynamoDB PAY_PER_REQUEST table declaring OnDemandThroughput caps plus
//     PointInTimeRecoverySpecification with ONLY the enable flag —
//     RecoveryPeriodInDays is AWS-filled (35) under a declared parent
//   - AWS::SQS::QueueInlinePolicy + AWS::SNS::TopicInlinePolicy (zero corpus;
//     the standalone QueuePolicy/TopicPolicy shapes are covered, the scalar-ref
//     inline twins are not)
//   - AWS::Kinesis::ResourcePolicy (zero corpus; policy-echo probe)
//   - AWS::ApiGateway::Model + AWS::ApiGateway::RequestValidator (both have CC
//     identifier adapters + enumerator emits but zero corpus — harvest)
//   - SSM Parameter with AllowedPattern declared (the SDK_SUPPLEMENT output has
//     zero declared-side corpus coverage)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnRestApi, CfnModel, CfnRequestValidator } from "aws-cdk-lib/aws-apigateway";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnStream, CfnResourcePolicy } from "aws-cdk-lib/aws-kinesis";
import { CfnFunction, CfnUrl } from "aws-cdk-lib/aws-lambda";
import { CfnQueue, CfnQueueInlinePolicy } from "aws-cdk-lib/aws-sqs";
import { CfnTopic, CfnTopicInlinePolicy } from "aws-cdk-lib/aws-sns";
import { CfnParameter } from "aws-cdk-lib/aws-ssm";
import { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0809T1Pack");

// ── Step Functions: JSONata + Distributed Map ──
const sfnRole = new Role(stack, "SfnRole", {
  assumedBy: new ServicePrincipal("states.amazonaws.com"),
});
new CfnStateMachine(stack, "JsonataSm", {
  stateMachineName: "cdkrd-hunt-0809-jsonata",
  roleArn: sfnRole.roleArn,
  definitionString: JSON.stringify({
    QueryLanguage: "JSONata",
    StartAt: "DMap",
    States: {
      DMap: {
        Type: "Map",
        Items: "{% [1, 2, 3] %}",
        ItemProcessor: {
          ProcessorConfig: { Mode: "DISTRIBUTED", ExecutionType: "STANDARD" },
          StartAt: "Inner",
          States: { Inner: { Type: "Pass", End: true } },
        },
        End: true,
      },
    },
  }),
});

// ── Lambda Function URL: RESPONSE_STREAM, Cors undeclared ──
const fnRole = new Role(stack, "FnRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
  ],
});
const fn = new CfnFunction(stack, "StreamFn", {
  functionName: "cdkrd-hunt-0809-streamfn",
  role: fnRole.roleArn,
  runtime: "nodejs22.x",
  handler: "index.handler",
  code: { zipFile: "exports.handler = async () => ({ ok: true });" },
});
new CfnUrl(stack, "StreamUrl", {
  targetFunctionArn: fn.attrArn,
  authType: "NONE",
  invokeMode: "RESPONSE_STREAM",
});

// ── DynamoDB: on-demand caps + PITR with RecoveryPeriodInDays undeclared ──
new CfnTable(stack, "OdtTable", {
  tableName: "cdkrd-hunt-0809-odt",
  billingMode: "PAY_PER_REQUEST",
  attributeDefinitions: [{ attributeName: "pk", attributeType: "S" }],
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  onDemandThroughput: { maxReadRequestUnits: 5, maxWriteRequestUnits: 5 },
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});

// ── SQS inline policy (scalar Queue ref shape) ──
const q = new CfnQueue(stack, "PolQueue", { queueName: "cdkrd-hunt-0809-inlinepol" });
new CfnQueueInlinePolicy(stack, "QInlinePol", {
  queue: q.ref,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowSns",
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: q.attrArn,
      },
    ],
  },
});

// ── SNS inline policy (scalar TopicArn shape) ──
const topic = new CfnTopic(stack, "PolTopic", { topicName: "cdkrd-hunt-0809-inlinepol" });
new CfnTopicInlinePolicy(stack, "TInlinePol", {
  topicArn: topic.ref,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowEvents",
        Effect: "Allow",
        Principal: { Service: "events.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topic.ref,
      },
    ],
  },
});

// ── Kinesis resource policy ──
const stream = new CfnStream(stack, "RpStream", {
  name: "cdkrd-hunt-0809-rp",
  shardCount: 1,
  streamModeDetails: { streamMode: "PROVISIONED" },
});
new CfnResourcePolicy(stack, "KRp", {
  resourceArn: stream.attrArn,
  resourcePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${stack.account}:root` },
        Action: "kinesis:DescribeStreamSummary",
        Resource: stream.attrArn,
      },
    ],
  },
});

// ── API Gateway Model + RequestValidator (zero-corpus harvest) ──
const api = new CfnRestApi(stack, "Api", { name: "cdkrd-hunt-0809-api" });
new CfnModel(stack, "Model", {
  restApiId: api.ref,
  name: "HuntModel0809",
  contentType: "application/json",
  schema: {
    $schema: "http://json-schema.org/draft-04/schema#",
    type: "object",
    properties: { id: { type: "string" } },
  },
});
new CfnRequestValidator(stack, "Rv", {
  restApiId: api.ref,
  name: "hunt-rv-0809",
  validateRequestBody: true,
  validateRequestParameters: false,
});

// ── SSM Parameter with AllowedPattern (supplement declared-side) ──
new CfnParameter(stack, "PatParam", {
  name: "cdkrd-hunt-0809-pat",
  type: "String",
  value: "abc123",
  allowedPattern: "^[a-z0-9]+$",
  description: "cdkrd hunt allowed-pattern probe",
});

app.synth();

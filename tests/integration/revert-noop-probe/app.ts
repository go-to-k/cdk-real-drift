// Barest-config bundle to live-probe the revert-convergence (silent no-op) class:
// each resource leaves KNOWN_DEFAULTS-folded MUTABLE scalars undeclared, so a
// `revert` of an out-of-band change to one of them must CONVERGE (not silently
// no-op). Probed here (2026-07-14 hunt, follow-up to #1580 ECR ImageTagMutability):
//   - SQS Queue: VisibilityTimeout / MessageRetentionPeriod / DelaySeconds /
//     ReceiveMessageWaitTimeSeconds / MaximumMessageSize (all via SetQueueAttributes)
//   - Lambda Function: RecursiveLoop (PutFunctionRecursionConfig)
//   - Lambda Url: InvokeMode (UpdateFunctionUrlConfig)
//   - DynamoDB Table: DeletionProtectionEnabled (UpdateTable)
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { CfnFunction, CfnUrl } from "aws-cdk-lib/aws-lambda";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { CfnRole } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntRevertNoop0714");

// --- SQS: barest queue (every attribute folds atDefault) ---
new CfnQueue(stack, "Queue", {});

// --- Lambda: barest inline function + its Function URL ---
const lambdaRole = new CfnRole(stack, "LambdaRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});
const fn = new CfnFunction(stack, "Fn", {
  code: { zipFile: "exports.handler = async () => 'ok';" },
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: lambdaRole.attrArn,
});
new CfnUrl(stack, "Url", {
  targetFunctionArn: fn.attrArn,
  authType: "NONE",
});

// --- DynamoDB: barest on-demand table (DeletionProtectionEnabled undeclared) ---
new CfnTable(stack, "Table", {
  billingMode: "PAY_PER_REQUEST",
  attributeDefinitions: [{ attributeName: "pk", attributeType: "S" }],
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
});

app.synth();

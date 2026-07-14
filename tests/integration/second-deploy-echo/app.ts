// Second-deploy echo probe (post-update echo materialization, the #1569 class):
// a clean FIRST-run check proves nothing about the post-UPDATE echo surface —
// some services normalize/materialize undeclared properties on EVERY update
// (Glue re-sent sizing echoes on UpdateJob, #1569). This fixture deploys ~15
// common, cheap, fast types in their barest form, asserts the first check is
// CLEAN, then performs a harmless stack UPDATE (a tag / description bump via
// `-c rev=2`) and asserts the check is STILL clean: any undeclared property
// that materializes only after the update is a latent FP every real user hits
// on their second `cdk deploy`.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { CfnUserPool } from "aws-cdk-lib/aws-cognito";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { CfnRepository } from "aws-cdk-lib/aws-ecr";
import { CfnFileSystem } from "aws-cdk-lib/aws-efs";
import { CfnRule } from "aws-cdk-lib/aws-events";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const rev = String(app.node.tryGetContext("rev") ?? "1");
Tags.of(app).add("cdkrd:ephemeral", "1");

const stack = new Stack(app, "CdkrdHuntEcho0714");
// The update trigger: bumping this tag revs every taggable resource in the
// stack through its CFn/CC update handler — the realistic "second deploy".
Tags.of(stack).add("cdkrd:rev", rev);

new CfnBucket(stack, "EchoBucket0714", {});
new CfnQueue(stack, "EchoQueue0714", {});
new CfnTopic(stack, "EchoTopic0714", {});
new CfnRepository(stack, "EchoRepo0714", {});
new CfnLogGroup(stack, "EchoLogs0714", {});
new CfnFileSystem(stack, "EchoEfs0714", {});
new CfnUserPool(stack, "EchoPool0714", {});
new CfnStream(stack, "EchoStream0714", { shardCount: 1 });

new CfnTable(stack, "EchoTable0714", {
  attributeDefinitions: [{ attributeName: "id", attributeType: "S" }],
  keySchema: [{ attributeName: "id", keyType: "HASH" }],
  billingMode: "PAY_PER_REQUEST",
});

// Events::Rule has no Tags property — the description carries the rev instead.
new CfnRule(stack, "EchoRule0714", {
  scheduleExpression: "rate(1 hour)",
  state: "DISABLED",
  description: `cdkrd echo probe rev ${rev}`,
});

new CfnWorkGroup(stack, "EchoWg0714", {
  name: "cdkrd-echo-wg-0714",
  description: `cdkrd echo probe rev ${rev}`,
});

const lambdaRole = new CfnRole(stack, "EchoLambdaRole0714", {
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
  description: `cdkrd echo probe rev ${rev}`,
});

new CfnFunction(stack, "EchoFn0714", {
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: lambdaRole.attrArn,
  code: { zipFile: "exports.handler = async () => 'ok';" },
  description: `cdkrd echo probe rev ${rev}`,
});

const sfnRole = new CfnRole(stack, "EchoSfnRole0714", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "states.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});

new CfnStateMachine(stack, "EchoSfn0714", {
  roleArn: sfnRole.attrArn,
  definitionString: JSON.stringify({
    StartAt: "Done",
    States: { Done: { Type: "Pass", End: true } },
  }),
});

const cbRole = new CfnRole(stack, "EchoCbRole0714", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "codebuild.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});

new CfnProject(stack, "EchoCb0714", {
  serviceRole: cbRole.attrArn,
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    computeType: "BUILD_GENERAL1_SMALL",
    image: "aws/codebuild/standard:7.0",
  },
  source: {
    type: "NO_SOURCE",
    buildSpec: JSON.stringify({
      version: "0.2",
      phases: { build: { commands: ["echo ok"] } },
    }),
  },
});

app.synth();

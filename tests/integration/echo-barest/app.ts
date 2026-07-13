// Barest-config fixture bundling several CHEAP, common, instant-deploy types
// whose service-materialized defaults are NOT in the fold tables (verified via
// grep of src/normalize/noise.ts + src/diff/classify.ts, 2026-07-14 hunt):
//   - Lambda Function  -> SnapStart {ApplyOn:"None"} (unfolded)
//   - ECR Repository   -> ImageScanningConfiguration {ScanOnPush:false} (unfolded)
//   - StepFunctions SM -> LoggingConfiguration / TracingConfiguration (unfolded)
//   - Kinesis Stream   -> StreamEncryption (unfolded)
// Each L1 declares only what CloudFormation REQUIRES, leaving the maximum
// undeclared surface so a first `check` (before record) exercises the folds.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnRepository } from "aws-cdk-lib/aws-ecr";
import { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnRole } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntEcho0714");

// --- Lambda: barest inline zip function ---
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
new CfnFunction(stack, "Fn", {
  code: { zipFile: "exports.handler = async () => 'ok';" },
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: lambdaRole.attrArn,
});

// --- ECR: barest repository (nothing is required) ---
new CfnRepository(stack, "Repo", {});

// --- StepFunctions: barest STANDARD state machine ---
const sfnRole = new CfnRole(stack, "SfnRole", {
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
new CfnStateMachine(stack, "Sm", {
  roleArn: sfnRole.attrArn,
  definitionString: JSON.stringify({
    StartAt: "Done",
    States: { Done: { Type: "Pass", End: true } },
  }),
});

// --- Kinesis: barest on-demand stream (no shard cost) ---
new CfnStream(stack, "Stream", {
  streamModeDetails: { streamMode: "ON_DEMAND" },
});

app.synth();

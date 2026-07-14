// Revert-convergence probe (the #1571 class, next batch): four KNOWN_DEFAULTS-folded,
// MUTABLE properties whose revert convergence has never been live-proven — Lambda
// TracingConfig.Mode (PassThrough), SQS DelaySeconds (0), KMS Key Enabled (true),
// ECR ImageTagMutability (MUTABLE). Each is mutated out of band, must be DETECTED,
// then `revert` must actually restore the LIVE value to the default (some Cloud
// Control handlers no-op an omitted property → REVERT_SET_DEFAULT_PATHS candidates;
// the API shape is not a predictor, only a live test answers).
import { App, Aws, Stack, Tags } from "aws-cdk-lib";
import { CfnRepository } from "aws-cdk-lib/aws-ecr";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnKey } from "aws-cdk-lib/aws-kms";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntRevConv0714");

new CfnQueue(stack, "ConvQueue0714", {});
new CfnRepository(stack, "ConvRepo0714", {});

new CfnKey(stack, "ConvKey0714", {
  keyPolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${Aws.ACCOUNT_ID}:root` },
        Action: "kms:*",
        Resource: "*",
      },
    ],
  },
});

const role = new CfnRole(stack, "ConvFnRole0714", {
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

new CfnFunction(stack, "ConvFn0714", {
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: role.attrArn,
  code: { zipFile: "exports.handler = async () => 'ok';" },
});

app.synth();

// CDK app for the cdk-real-drift grabbag-hunt false-positive integration test.
// A grab-bag of BAREST minimal configs for cheap, common types whose
// undeclared-default first-run path has never been exercised live:
//   - AWS::ECR::RepositoryCreationTemplate — zero corpus/fixture; its Prefix
//     trailing-slash CC identifier adapter has never run against real AWS.
//   - AWS::SNS::Topic FIFO variant — corpus has only FifoTopic:false topics.
//   - AWS::Events::Rule with a rate() schedule and no targets — barest form.
//   - AWS::Glue::Job barest (role + command only) — many optional props with
//     service defaults.
//   - AWS::Athena::WorkGroup barest (name only) — existing corpus cases all
//     declare configuration.
//   - AWS::Lambda::Function barest L1 (no L2 defaults) — probes the SnapStart /
//     RuntimeManagementConfig undeclared surface.
// A clean first `check` (before `record`) must show ZERO potential drift.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnRepositoryCreationTemplate } from "aws-cdk-lib/aws-ecr";
import { CfnRule } from "aws-cdk-lib/aws-events";
import { CfnJob } from "aws-cdk-lib/aws-glue";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnTopic } from "aws-cdk-lib/aws-sns";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntGrabBag0713");

new CfnRepositoryCreationTemplate(stack, "EcrTemplate", {
  prefix: "cdkrd-hunt-0713",
  appliedFor: ["PULL_THROUGH_CACHE"],
});

new CfnTopic(stack, "FifoTopic", {
  topicName: "cdkrd-hunt-0713.fifo",
  fifoTopic: true,
});

new CfnRule(stack, "RateRule", {
  scheduleExpression: "rate(1 hour)",
});

const glueRole = new CfnRole(stack, "GlueRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "glue.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});

new CfnJob(stack, "GlueJob", {
  role: glueRole.attrArn,
  command: {
    name: "glueetl",
    scriptLocation: "s3://cdkrd-hunt-nonexistent/script.py",
  },
});

new CfnWorkGroup(stack, "AthenaWg", {
  name: "cdkrd-hunt-wg-0713",
});

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

new CfnFunction(stack, "BareFn", {
  role: lambdaRole.attrArn,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
});

app.synth();

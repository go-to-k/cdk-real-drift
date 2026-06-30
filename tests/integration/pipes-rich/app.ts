// CDK app for the cdk-real-drift EventBridge Pipes false-positive test. A Pipe
// (source -> optional filter/enrichment -> target) is a common point-to-point
// integration. It packs the FP-prone surfaces: nested SourceParameters /
// TargetParameters bags with enums (BatchSize, MaximumBatchingWindowInSeconds),
// a FilterCriteria whose Pattern is a JSON-STRING (object-vs-string shape), and
// the standard Tags map. A freshly deployed + recorded Pipe with NO out-of-band
// change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegPipesRich");

const source = new CfnQueue(stack, "SourceQueue", { queueName: "cdkrd-pipe-src" });
const target = new CfnQueue(stack, "TargetQueue", { queueName: "cdkrd-pipe-tgt" });

const role = new CfnRole(stack, "PipeRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "pipes.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  policies: [
    {
      policyName: "pipe",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
            Resource: source.attrArn,
          },
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: target.attrArn,
          },
        ],
      },
    },
  ],
});

new CfnPipe(stack, "Pipe", {
  name: "cdkrd-pipe-rich",
  roleArn: role.attrArn,
  source: source.attrArn,
  target: target.attrArn,
  desiredState: "RUNNING",
  sourceParameters: {
    sqsQueueParameters: {
      batchSize: 5,
      maximumBatchingWindowInSeconds: 10,
    },
    // FilterCriteria.Filter.Pattern is a JSON-STRING in CFn — exercises the
    // object-vs-JSON-string shape class.
    filterCriteria: {
      filters: [{ pattern: '{"body":{"type":["order"]}}' }],
    },
  },
  tags: { owner: "cdkrd", env: "hunt" },
});

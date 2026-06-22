// CDK app for the cdk-real-drift EventBridge rich-EventPattern false-positive
// test. EventBridge rules are extremely common, and a rich EventPattern with
// content-based filtering (prefix / anything-but / exists / numeric) plus a rich
// target (InputTransformer + RetryPolicy + DeadLetterConfig) is a "production"
// shape the existing simple Events::Rule fixtures don't exercise. AWS may
// reformat the EventPattern JSON or fold target defaults. A freshly deployed +
// recorded rule with NO out-of-band change MUST report CLEAN.
import { App, Duration, Stack } from "aws-cdk-lib";
import { CfnRule } from "aws-cdk-lib/aws-events";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEventBridgeRichPattern");

const target = new Queue(stack, "Target", {
  retentionPeriod: Duration.days(1),
});
const dlq = new Queue(stack, "Dlq", {
  retentionPeriod: Duration.days(1),
});

new CfnRule(stack, "Rule", {
  name: "cdkrd-integ-richpattern",
  description: "rich content-filtered pattern",
  state: "ENABLED",
  // Content-based filtering: prefix, anything-but, exists, numeric — a nested
  // pattern AWS stores and echoes back, potentially reformatted/reordered.
  eventPattern: {
    source: ["aws.s3", "custom.app"],
    "detail-type": ["Object Created"],
    detail: {
      bucket: { name: [{ prefix: "cdkrd-" }] },
      object: {
        size: [{ numeric: [">", 1024] }],
        key: [{ "anything-but": ["tmp/", "cache/"] }],
        etag: [{ exists: true }],
      },
    },
  },
  targets: [
    {
      id: "queue",
      arn: target.queueArn,
      deadLetterConfig: { arn: dlq.queueArn },
      retryPolicy: {
        maximumRetryAttempts: 3,
        maximumEventAgeInSeconds: 3600,
      },
      inputTransformer: {
        inputPathsMap: {
          bucketName: "$.detail.bucket.name",
          objectKey: "$.detail.object.key",
        },
        inputTemplate: '{"bucket":<bucketName>,"key":<objectKey>}',
      },
    },
  ],
});

app.synth();

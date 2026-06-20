// CDK app for the cdk-real-drift "rich false-positive" integration test.
// Mixes several property-rich resource types that were NOT previously covered by a
// dedicated clean-check fixture, to surface normalization / default-folding false
// positives: a freshly deployed + recorded stack with NO out-of-band change MUST
// report CLEAN. Each type stresses a different normalization edge:
//   - Kinesis Stream:   StreamModeDetails + RetentionPeriodHours + StreamEncryption
//   - SQS FIFO queue:    JSON-string RedrivePolicy (with a GetAtt ARN), dedup scope
//   - SNS FIFO topic:    ContentBasedDeduplication + Fifo flags
//   - CloudWatch Dash:   DashboardBody is a JSON string built via Fn::Join intrinsics
//   - Secrets Manager:   GenerateSecretString + a resource policy
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Dashboard, TextWidget } from "aws-cdk-lib/aws-cloudwatch";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue, DeduplicationScope, FifoThroughputLimit } from "aws-cdk-lib/aws-sqs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRichFp");

new Stream(stack, "Events", {
  streamMode: StreamMode.PROVISIONED,
  shardCount: 1,
  retentionPeriod: Duration.hours(48),
});

const dlq = new Queue(stack, "Dlq", {
  fifo: true,
  contentBasedDeduplication: true,
  removalPolicy: RemovalPolicy.DESTROY,
});
new Queue(stack, "Work", {
  fifo: true,
  contentBasedDeduplication: true,
  deduplicationScope: DeduplicationScope.MESSAGE_GROUP,
  fifoThroughputLimit: FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
  deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
  removalPolicy: RemovalPolicy.DESTROY,
});

new Topic(stack, "Notify", {
  fifo: true,
  contentBasedDeduplication: true,
});

new Dashboard(stack, "Board", {
  dashboardName: "CdkRealDriftIntegRichFpBoard",
  widgets: [[new TextWidget({ markdown: "# cdkrd rich-fp", width: 24, height: 2 })]],
});

new Secret(stack, "ApiKey", {
  description: "cdkrd rich-fp test secret",
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: "svc" }),
    generateStringKey: "password",
    excludeCharacters: '"@/\\',
  },
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

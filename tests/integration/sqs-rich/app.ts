// CDK app for the cdk-real-drift SQS false-positive test. The basic sqs fixture
// covers a plain queue; this exercises the common "production queue" knobs at
// once: SSE-SQS managed encryption (SqsManagedSseEnabled), a dead-letter queue
// with a RedrivePolicy (a JSON-string attribute), long polling, and explicit
// visibility/retention/delay — attributes SQS returns as a flat string bag that
// must normalize without an FP. A freshly deployed + recorded queue with NO
// out-of-band change MUST report CLEAN.
import { App, Duration, Stack } from "aws-cdk-lib";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSqsRich");

const dlq = new Queue(stack, "Dlq", {
  queueName: "cdkrd-sqs-rich-dlq",
  retentionPeriod: Duration.days(14),
  encryption: QueueEncryption.SQS_MANAGED,
});

new Queue(stack, "Main", {
  queueName: "cdkrd-sqs-rich",
  visibilityTimeout: Duration.seconds(60),
  retentionPeriod: Duration.days(4),
  receiveMessageWaitTime: Duration.seconds(10),
  deliveryDelay: Duration.seconds(5),
  encryption: QueueEncryption.SQS_MANAGED,
  deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
});

app.synth();

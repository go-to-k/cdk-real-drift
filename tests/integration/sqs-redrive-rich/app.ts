// cdk-real-drift SQS RedriveAllowPolicy + SSE-KMS false-positive test.
// Existing SQS fixtures cover SSE-SQS, RedrivePolicy and FIFO high-throughput, but
// NOT RedriveAllowPolicy (a JSON-string queue attribute — a string<->object
// coercion FP candidate) nor SSE-KMS (which default-fills KmsDataKeyReusePeriod to
// 300s — an undeclared/atDefault surface). A freshly deployed + recorded queue with
// NO out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { Queue, QueueEncryption, RedrivePermission } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSqsRedriveRich");

const key = new Key(stack, "Key", { removalPolicy: RemovalPolicy.DESTROY });

// DLQ with an explicit RedriveAllowPolicy (allow-all avoids a circular ref) and
// SSE-KMS encryption.
const dlq = new Queue(stack, "Dlq", {
  encryption: QueueEncryption.KMS,
  encryptionMasterKey: key,
  dataKeyReuse: Duration.minutes(10),
  redriveAllowPolicy: {
    redrivePermission: RedrivePermission.ALLOW_ALL,
  },
});

// Main queue: SSE-KMS + a RedrivePolicy pointing at the DLQ.
new Queue(stack, "Main", {
  encryption: QueueEncryption.KMS,
  encryptionMasterKey: key,
  visibilityTimeout: Duration.seconds(45),
  deadLetterQueue: {
    queue: dlq,
    maxReceiveCount: 5,
  },
});

app.synth();

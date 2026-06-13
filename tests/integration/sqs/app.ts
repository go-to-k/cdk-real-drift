// CDK app for the cdk-real-drift SQS false-positive integration test (R88).
// Tricky declared property: RedrivePolicy — CDK declares it as an OBJECT (with an
// intrinsic ref to the DLQ ARN), but SQS returns it as a JSON STRING (R75
// object<->JSON-string equality). Plus numeric attributes (VisibilityTimeout, etc.)
// and tags. The `policies` fixture covers the queue ACCESS policy; this covers the
// queue ATTRIBUTES.
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSqs");

const dlq = new Queue(stack, "Dlq", { retentionPeriod: Duration.days(14) });
const queue = new Queue(stack, "Main", {
  visibilityTimeout: Duration.seconds(45),
  retentionPeriod: Duration.days(4),
  deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
});
Tags.of(queue).add("team", "platform");
Tags.of(queue).add("cost-center", "1234");

app.synth();

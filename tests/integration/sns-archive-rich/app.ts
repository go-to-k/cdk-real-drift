// CDK app for the cdk-real-drift SNS FIFO archive false-positive test. SNS is a
// very common CDK resource, but the FIFO archive knobs are not yet exercised: a
// FIFO topic with content-based dedup, a message-archive retention policy
// (ArchivePolicy), an explicit signature version, and active tracing. ArchivePolicy
// is the interesting one — CloudFormation declares it as a nested OBJECT
// (`{ MessageRetentionPeriod: 30 }`) while the SNS API stores topic attributes as
// strings, so the live read can come back JSON-STRING-shaped: a classic
// object<->string normalization false-positive surface. A freshly deployed +
// recorded topic with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { Topic, TracingConfig } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsArchiveRich");

new Topic(stack, "Topic", {
  fifo: true,
  contentBasedDeduplication: true,
  // FIFO message archive — emits ArchivePolicy: { MessageRetentionPeriod: 30 }.
  messageRetentionPeriodInDays: 30,
  signatureVersion: "2",
  tracingConfig: TracingConfig.ACTIVE,
  displayName: "cdkrd sns archive rich",
});

app.synth();

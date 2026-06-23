// CDK app for the cdk-real-drift SNS Topic revert-gap probe. SNS topic
// configuration is an "attribute bag": the API stores DisplayName / SignatureVersion
// / TracingConfig / KmsMasterKeyId as individual topic attributes set one key at a
// time (SetTopicAttributes), and cdkrd reverts a Topic via Cloud Control
// UpdateResource. This fixture deploys a standard (non-FIFO) topic declaring four
// mutable attributes so the companion verify-revert.sh can mutate each out of band
// and confirm `cdkrd revert` (Cloud Control) actually writes each one back — i.e.
// whether any SNS Topic attribute is a "CC-readable but CC-revert-rejects" gap that
// would need a type-specific SDK writer. A freshly deployed + recorded topic with NO
// out-of-band change must also report CLEAN (false-positive guard).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { Topic, TracingConfig } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsRevertAttrs");

const key = new Key(stack, "TopicKey", {
  removalPolicy: RemovalPolicy.DESTROY,
  pendingWindow: undefined, // default 30-day window; swept on teardown
});

new Topic(stack, "Topic", {
  displayName: "cdkrd revert original",
  signatureVersion: "2",
  tracingConfig: TracingConfig.ACTIVE,
  masterKey: key,
});

app.synth();

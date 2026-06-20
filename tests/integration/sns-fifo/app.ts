// CDK app for the cdk-real-drift FIFO SNS topic false-positive test.
// The existing SNS fixtures cover a standard topic's tags / subscriptions; a FIFO
// topic exercises a fresh cluster of declared properties at once: FifoTopic=true,
// ContentBasedDeduplication=true, a server-side-encryption KmsMasterKeyId (an
// intrinsic ref to a customer key), and the .fifo-suffixed TopicName. A freshly
// deployed + recorded topic with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsFifo");

const key = new Key(stack, "TopicKey", {
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

const topic = new Topic(stack, "Events", {
  fifo: true,
  contentBasedDeduplication: true,
  masterKey: key,
});
Tags.of(topic).add("team", "platform");
Tags.of(topic).add("cost-center", "1234");

app.synth();

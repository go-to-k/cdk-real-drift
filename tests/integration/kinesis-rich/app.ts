// CDK app for the cdk-real-drift richly-configured Kinesis Data Stream
// false-positive test. Kinesis is a common streaming primitive; the existing
// coverage only exists inside the normalization corpus (harvest fixtures), never as
// a deploy-verified FP integ. This one piles on the production knobs that each add a
// normalization edge: a PROVISIONED StreamModeDetails (CDK now defaults to ON_DEMAND,
// so the explicit mode is a fresh shape), an explicit shard count, a non-default
// 48-hour retention period (RetentionPeriodHours folds a 24h default), and KMS
// server-side encryption (a StreamEncryption sub-object with an intrinsic key ref). A
// freshly deployed + recorded stream with NO out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { Stream, StreamEncryption, StreamMode } from "aws-cdk-lib/aws-kinesis";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegKinesisRich");

const key = new Key(stack, "StreamKey", {
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

const stream = new Stream(stack, "Events", {
  streamMode: StreamMode.PROVISIONED,
  shardCount: 2,
  retentionPeriod: Duration.hours(48),
  encryption: StreamEncryption.KMS,
  encryptionKey: key,
});
Tags.of(stream).add("team", "platform");
Tags.of(stream).add("cost-center", "1234");

app.synth();

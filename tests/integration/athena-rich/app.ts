// CDK app for the cdk-real-drift richly-configured Athena work group false-positive
// test. Athena work groups are a daily driver for every analytics / data team, yet
// existing coverage is only the harvest snapshot corpus — never a deploy-verified FP
// integ. This one exercises the knobs that each add a normalization edge:
// WorkGroupConfiguration nests several sub-objects (ResultConfiguration with an S3
// OutputLocation + EncryptionConfiguration, EnforceWorkGroupConfiguration /
// PublishCloudWatchMetricsEnabled booleans, BytesScannedCutoffPerQuery numeric,
// EngineVersion enum). Description is a top-level MUTABLE scalar — the FN oracle in
// verify-detect.sh edits it out of band. A freshly deployed + recorded work group
// with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAthenaRich");

const results = new Bucket(stack, "Results", {
  encryption: BucketEncryption.S3_MANAGED,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

new CfnWorkGroup(stack, "WorkGroup", {
  name: "cdkrd-integ-athena-rich",
  description: "cdkrd athena-rich test work group",
  recursiveDeleteOption: true,
  state: "ENABLED",
  workGroupConfiguration: {
    enforceWorkGroupConfiguration: true,
    publishCloudWatchMetricsEnabled: true,
    bytesScannedCutoffPerQuery: 10_000_000,
    engineVersion: { selectedEngineVersion: "Athena engine version 3" },
    resultConfiguration: {
      outputLocation: results.s3UrlForObject("athena-results/"),
      encryptionConfiguration: { encryptionOption: "SSE_S3" },
    },
  },
  tags: [
    { key: "team", value: "platform" },
    { key: "cost-center", value: "1234" },
  ],
});

app.synth();

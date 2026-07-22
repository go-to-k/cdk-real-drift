// Unexercised-adapter probe (real AWS): AWS::ElasticBeanstalk::ApplicationVersion
// has a CC_IDENTIFIER_ADAPTERS entry (compositeWith ApplicationName) with zero
// corpus and zero fixture coverage — the composite `ApplicationName|Id` read
// path has never run against a live resource. Deploy the barest Application +
// ApplicationVersion (S3 source bundle via a CDK asset; no Environment — that
// is the slow/expensive part) and assert the first check is CLEAN with zero
// skipped reads.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnApplication, CfnApplicationVersion } from "aws-cdk-lib/aws-elasticbeanstalk";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722EbAv");

const bundle = new Asset(stack, "HuntBundle", {
  path: path.join(here, "bundle"),
});

const ebApp = new CfnApplication(stack, "HuntEbApp", {
  applicationName: "cdkrd-hunt0722-ebav",
});

new CfnApplicationVersion(stack, "HuntEbAppVersion", {
  applicationName: ebApp.ref,
  sourceBundle: {
    s3Bucket: bundle.s3BucketName,
    s3Key: bundle.s3ObjectKey,
  },
});

app.synth();

// CDK app for the cdk-real-drift S3 lifecycle "no explicit Id" false-positive
// test. `bucket.addLifecycleRule({...})` WITHOUT an `id` is the most common way
// CDK users declare lifecycle rules, and the synthesized template omits Rules[].Id.
// AWS S3 then AUTO-ASSIGNS a (random) Id to every rule and echoes it on read. The
// risk: the live rules all carry an Id (so cdkrd's identity-keyed canonicalizer
// sorts the LIVE side by that generated Id) while the declared rules carry none
// (so the declared side stays in template order) — if the generated Ids sort in a
// different order than declared, the positional compare MISALIGNS and false-flags
// every rule. Three distinct no-id rules maximize the chance of a sort mismatch.
// A freshly deployed + recorded bucket with NO out-of-band change MUST be CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Bucket, StorageClass } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3LifecycleNoid");

const bucket = new Bucket(stack, "Data", {
  versioned: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

// All three rules declared WITHOUT an id (the CDK default). Distinct prefixes so
// the rules are unambiguous, declared in an order unlikely to match AWS's
// generated-Id sort order.
bucket.addLifecycleRule({
  prefix: "zeta/",
  transitions: [{ storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) }],
  expiration: Duration.days(365),
});
bucket.addLifecycleRule({
  prefix: "alpha/",
  abortIncompleteMultipartUploadAfter: Duration.days(7),
});
bucket.addLifecycleRule({
  prefix: "mike/",
  noncurrentVersionTransitions: [
    { storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(90) },
  ],
  noncurrentVersionExpiration: Duration.days(180),
});

app.synth();

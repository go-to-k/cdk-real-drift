// Barest-config ELBv2 TrustStore fixture for the cdk-real-drift FP hunt.
// AWS::ElasticLoadBalancingV2::TrustStore has a `supplementTrustStore`
// SDK_SUPPLEMENT that was added without ever being exercised live. The CA
// bundle must exist in S3 BEFORE the stack deploys, so verify.sh pre-creates
// the bucket + a self-signed CA PEM out of band and passes the location via
// CDKRD_HUNT_TS_BUCKET / CDKRD_HUNT_TS_KEY (env is set for deploy AND for
// every cdkrd invocation, which re-synthesizes this app).
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnTrustStore } from "aws-cdk-lib/aws-elasticloadbalancingv2";

const bucket = process.env.CDKRD_HUNT_TS_BUCKET;
const key = process.env.CDKRD_HUNT_TS_KEY ?? "ca-bundle.pem";
if (!bucket) throw new Error("CDKRD_HUNT_TS_BUCKET must be set (see verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntTrustStore0712c");

// Barest trust store: only the required CA bundle location + a name.
new CfnTrustStore(stack, "TrustStore", {
  name: "cdkrd-hunt-truststore-0712c",
  caCertificatesBundleS3Bucket: bucket,
  caCertificatesBundleS3Key: key,
});

app.synth();

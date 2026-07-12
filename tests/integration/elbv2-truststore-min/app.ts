// CDK app for the cdk-real-drift elbv2-truststore-min false-positive integration test.
// BAREST-possible AWS::ElasticLoadBalancingV2::TrustStore — the ONLY
// SDK_SUPPLEMENTS entry with zero fixture/corpus coverage: its writeOnly
// CaCertificatesBundle* supplement path has never been exercised live.
// The CA bundle object must exist BEFORE the TrustStore is created, so the
// runner pre-creates the bucket + uploads a self-signed CA PEM (see verify.sh)
// and passes the location via CA_BUNDLE_BUCKET / CA_BUNDLE_KEY.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnTrustStore } from "aws-cdk-lib/aws-elasticloadbalancingv2";

const bucket = process.env.CA_BUNDLE_BUCKET;
const key = process.env.CA_BUNDLE_KEY ?? "cdkrd-hunt-ca.pem";
if (!bucket) throw new Error("CA_BUNDLE_BUCKET env var is required (see verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713TrustStore");

new CfnTrustStore(stack, "HuntTrustStore", {
  name: "cdkrd-hunt-truststore",
  caCertificatesBundleS3Bucket: bucket,
  caCertificatesBundleS3Key: key,
});

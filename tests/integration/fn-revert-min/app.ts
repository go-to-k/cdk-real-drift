// CDK app for the cdk-real-drift fn-revert-min DETECTION (false-negative)
// integration test. Two probes driven by verify.sh:
// - AWS::SQS::Queue with a declared MUTABLE VisibilityTimeout: the standard
//   out-of-band-mutate -> detect -> revert -> clean cycle (declared loop).
// - AWS::DMS::Endpoint minimal: after `record`, an out-of-band SslMode
//   hardening must RE-SURFACE — live proof that the #1490 KNOWN_DEFAULTS fold
//   is equality-gated (folds only the "none" default, not any value).
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnEndpoint } from "aws-cdk-lib/aws-dms";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegFnRevertMin");

new CfnQueue(stack, "HuntQueue", {
  visibilityTimeout: 45,
});

// postgres, not mysql: the out-of-band mutation flips SslMode to "require",
// which DMS supports certificate-free for postgres only (mysql rejects it).
new CfnEndpoint(stack, "HuntDmsEndpoint", {
  endpointIdentifier: "cdkrd-hunt-fn-dms-ep",
  endpointType: "source",
  engineName: "postgres",
  serverName: "hunt.invalid",
  port: 5432,
  databaseName: "huntdb",
  username: "hunter",
  password: "cdkrd-hunt-password-1",
});

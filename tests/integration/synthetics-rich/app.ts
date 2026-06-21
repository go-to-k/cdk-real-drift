// CDK app for the cdk-real-drift synthetics-rich false-positive integration test.
// A CloudWatch Synthetics Canary is a common uptime/API monitor. It folds a RunConfig,
// a Schedule, ArtifactS3Location, and Code into AWS's model with defaults — a clean
// `record`->`check` is a false-positive oracle for the Synthetics path. The runtime is
// pinned via the escape hatch (`new Runtime(...)`) to a CURRENTLY non-deprecated
// version (named CDK enum consts drift / deprecate, like the OpenSearch/RDS lesson);
// verify with `aws synthetics describe-runtime-versions`. The canary uses its OWN
// autoDelete artifacts bucket so teardown leaves no orphan (its custom-resource Lambda
// log group + the canary's cwsyn-* log group both carry the cdkrd token for the sweep).
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  Canary,
  Code,
  Runtime,
  RuntimeFamily,
  Schedule,
  Test,
} from "aws-cdk-lib/aws-synthetics";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSyntheticsRich");

const artifacts = new Bucket(stack, "CanaryArtifacts", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

new Canary(stack, "Canary", {
  canaryName: "cdkrd-canary",
  runtime: new Runtime("syn-nodejs-puppeteer-16.1", RuntimeFamily.NODEJS),
  artifactsBucketLocation: { bucket: artifacts },
  schedule: Schedule.rate(Duration.hours(1)),
  test: Test.custom({
    handler: "index.handler",
    code: Code.fromInline(
      "exports.handler = async function () { return 'cdkrd canary ok'; };"
    ),
  }),
});

app.synth();

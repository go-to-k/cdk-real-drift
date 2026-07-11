// CDK app for the cdk-real-drift lambda-java-min false-positive integration
// test. A MINIMAL java21 Lambda function: Java is the only runtime family
// whose live read echoes `SnapStart` ({ApplyOn:"None"} when undeclared) — the
// corpus is all nodejs/python (no SnapStart key at all) and noise.ts has no
// SnapStart fold, so this probes an expected first-run FP. The handler asset
// is a placeholder (never invoked — create-time only validates the zip
// exists).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import * as path from "node:path";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegLambdaJavaMin");

new LambdaFunction(stack, "HuntJavaFn", {
  runtime: Runtime.JAVA_21,
  handler: "example.Handler::handleRequest",
  code: Code.fromAsset(path.join(import.meta.dirname, "handler")),
});

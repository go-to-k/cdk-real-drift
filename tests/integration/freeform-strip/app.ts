// Minimal CDK app for the cc-api-strip free-form-map false-negative test. A Lambda with
// ONE declared env var. verify-freeform-strip.sh adds an out-of-band env var whose KEY
// collides with an AWS-managed field name (`LastModified`); cc-api-strip used to strip
// it by name at any depth, so the out-of-band change was SILENTLY undetectable. The fix
// stops stripping inside free-form user maps (Environment.Variables), so it now surfaces.
import { App, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegFreeform");
new Function(stack, "TestFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  environment: { APP_VERSION: "x" },
});
app.synth();

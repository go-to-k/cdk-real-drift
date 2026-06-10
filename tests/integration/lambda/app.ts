// Minimal CDK app for the cdk-real-drift Lambda integration test.
// One Node.js 20 Lambda with inline code; no reserved concurrency declared.
import { App, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambda");
new Function(stack, "TestFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  description: "cdk-real-drift Lambda integration test function",
});
app.synth();

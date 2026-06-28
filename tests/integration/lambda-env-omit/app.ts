// CDK app probing whether the OMITTED_WHEN_EMPTY false-negative class extends to
// AWS::Lambda::Function Environment (the second-most common resource). Declared env
// vars removed out of band (`update-function-configuration --environment
// '{"Variables":{}}'`) — if Cloud Control then OMITS Environment, the declared
// value's removal would misclassify as a readGap -> CLEAN -> silent FN.
import { App, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaEnvOmit");

new Function(stack, "Fn", {
  runtime: Runtime.NODEJS_18_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ ok: true });"),
  environment: { FOO: "bar", BAZ: "qux" },
});

app.synth();

// CDK app for the cdk-real-drift lambda-runtimes-min false-positive integration test.
// BAREST-possible Lambda functions on the runtimes with ZERO corpus coverage
// (covered today: nodejs18/20/24, java21, python3.12): dotnet8, ruby3.3,
// provided.al2023. Runtime-specific live defaults (e.g. SnapStart on dotnet)
// are exactly where first-run FPs hide. The asset is a dummy zip — Lambda
// does not validate handler existence at create time and is never invoked.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713LambdaRuntimes");

new LambdaFunction(stack, "HuntDotnet", {
  runtime: Runtime.DOTNET_8,
  handler: "App::App.Function::Handler",
  code: Code.fromAsset("./handler"),
});

new LambdaFunction(stack, "HuntRuby", {
  runtime: Runtime.RUBY_3_3,
  handler: "handler.handler",
  code: Code.fromAsset("./handler"),
});

new LambdaFunction(stack, "HuntProvided", {
  runtime: Runtime.PROVIDED_AL2023,
  handler: "bootstrap",
  code: Code.fromAsset("./handler"),
});

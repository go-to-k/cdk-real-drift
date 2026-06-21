// CDK app for the cdk-real-drift Secrets Manager rotation false-positive test.
// Automatic rotation is a common best practice, and AWS::SecretsManager::
// RotationSchedule has not been exercised. The interesting surface is the nested
// RotationRules (AutomaticallyAfterDays / Duration / ScheduleExpression) plus
// RotateImmediatelyOnUpdate — a small nested config block with service defaults
// that is exactly the shape that has produced false positives elsewhere. A dummy
// rotation Lambda backs the schedule (it is never actually invoked here:
// rotateImmediatelyOnUpdate is false). A freshly deployed + recorded stack with NO
// out-of-band change MUST report CLEAN.
import { App, Duration, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { RotationSchedule, Secret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSecretRotationRich");

const secret = new Secret(stack, "Secret", {
  description: "cdk-real-drift integ rotated secret",
});

const rotationFn = new Function(stack, "RotationFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ ok: true });"),
});

new RotationSchedule(stack, "Rotation", {
  secret,
  rotationLambda: rotationFn,
  automaticallyAfter: Duration.days(30),
  rotateImmediatelyOnUpdate: false,
});

app.synth();

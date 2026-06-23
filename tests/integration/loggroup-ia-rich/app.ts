// cdk-real-drift CloudWatch LogGroup INFREQUENT_ACCESS class false-positive test.
// The Standard-IA log class is increasingly common; LogGroupClass defaults to STANDARD
// and IA constrains which features are allowed, so the class round-trip + the
// retention/KMS folds are the FP surface. A freshly deployed + recorded log group with
// NO out-of-band change MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { LogGroup, LogGroupClass, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLogGroupIaRich");

new LogGroup(stack, "Logs", {
  logGroupClass: LogGroupClass.INFREQUENT_ACCESS,
  retention: RetentionDays.TWO_WEEKS,
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

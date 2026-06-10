// Minimal CDK app for the cdk-real-drift IAM integration test.
// One IAM Role assumed by ec2.amazonaws.com, no permissions boundary declared.
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIam");
new Role(stack, "TestRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  description: "cdk-real-drift IAM integration test role",
});
app.synth();

// Minimal CDK app for the cdk-real-drift IAM integration tests.
// One IAM Role assumed by ec2.amazonaws.com, no permissions boundary declared.
// addToPolicy() creates the sibling AWS::IAM::Policy (the CDK "DefaultPolicy"
// pattern) that verify-inline-policy.sh exercises: the sibling's entry in the
// role's live Policies must be filtered, while an out-of-band inline policy
// added next to it must still be detected and reverted.
import { App, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIam");
const role = new Role(stack, "TestRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  description: "cdk-real-drift IAM integration test role",
});
role.addToPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["s3:ListAllMyBuckets"],
    resources: ["*"],
  }),
);
app.synth();

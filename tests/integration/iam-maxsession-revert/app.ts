// Minimal CDK app for the cdk-real-drift IAM MaxSessionDuration revert integ.
//
// Stack CdkRealDriftIntegIamMaxSession: one IAM Role that does NOT declare
// MaxSessionDuration, so live it sits at the AWS default (3600). verify.sh sets it to
// 7200 out of band and proves `revert` converges it back to 3600 — the SET-DEFAULT case
// (IAM UpdateRole ignores an absent MaxSessionDuration, so a bare RFC6902 `remove` is a
// silent no-op; the revert must write the known default explicitly).
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIamMaxSession");
new Role(stack, "TestRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  description: "cdk-real-drift IAM MaxSessionDuration revert integ role",
});

app.synth();

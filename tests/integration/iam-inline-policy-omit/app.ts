// CDK app probing whether the OMITTED_WHEN_EMPTY false-negative class extends to
// AWS::IAM::Role inline `Policies`. An inline policy removed out of band
// (`aws iam delete-role-policy`) is a classic, security-relevant change. If AWS's
// Cloud Control read OMITS `Policies` when the role has none, the declared policy's
// removal would (pre-fix) misclassify as a readGap -> CLEAN -> silent FN. This
// fixture deploys a role with one inline policy declared DIRECTLY on the role (not a
// sibling AWS::IAM::Policy) so the role-level compare is exercised.
import { App, Stack } from "aws-cdk-lib";
import { CfnRole } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIamInlinePolicyOmit");

new CfnRole(stack, "Role", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  policies: [
    {
      policyName: "cdkrd-inline-1",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
      },
    },
  ],
});

app.synth();

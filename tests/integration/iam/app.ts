// Minimal CDK app for the cdk-real-drift IAM integration tests.
//
// Stack CdkRealDriftIntegIam: one IAM Role assumed by ec2.amazonaws.com, no
// permissions boundary declared. addToPolicy() creates the sibling AWS::IAM::Policy
// (the CDK "DefaultPolicy" pattern) that verify-inline-policy.sh exercises: the
// sibling's entry in the role's live Policies must be filtered, while an out-of-band
// inline policy added next to it must still be detected and reverted (UNDECLARED case).
//
// Stack CdkRealDriftIntegIamDeclared: a role that DECLARES an inline policy via
// `inlinePolicies` (so the template's Properties.Policies is non-empty). A rogue
// inline policy added out of band makes the role's live Policies a length-2 array vs
// the declared length-1 — a DECLARED whole-array drift. verify-declared-inline-revert.sh
// exercises that revert deletes ONLY the rogue and keeps the declared policy (the
// declared-revert `prior` fix). A separate stack so the two roles never collide in the
// single-role queries the existing scripts run.
import { App, Stack } from "aws-cdk-lib";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";

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

const declaredStack = new Stack(app, "CdkRealDriftIntegIamDeclared");
new Role(declaredStack, "DeclaredRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  description: "cdk-real-drift IAM integration test role with a DECLARED inline policy",
  inlinePolicies: {
    DeclaredPolicy: new PolicyDocument({
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["s3:ListAllMyBuckets"],
          resources: ["*"],
        }),
      ],
    }),
  },
});

app.synth();

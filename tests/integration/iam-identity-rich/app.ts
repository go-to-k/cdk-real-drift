// Minimal CDK app for the cdk-real-drift IAM-identity integration test.
//
// Stack CdkRealDriftIntegIamIdentityRich exercises two common, previously-untested
// IAM identity resource types deployed by a large fraction of CDK users:
//   * AWS::IAM::OIDCProvider   — the GitHub Actions OIDC federation pattern
//                                (token.actions.githubusercontent.com). Uses the L1
//                                CfnOIDCProvider so the NATIVE CFn type is exercised,
//                                not the custom-resource-backed L2.
//   * AWS::IAM::InstanceProfile — the EC2 instance-profile pattern (role attached to
//                                an instance).
//
// A freshly deployed, un-mutated stack must produce ZERO [Potential Drift] on a first
// `check` (before `record`) — every value AWS assigns undeclared (a ThumbprintList
// AWS may materialize, an InstanceProfile Path default of "/") must fold to atDefault.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnInstanceProfile,
  CfnOIDCProvider,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIamIdentityRich");

// The GitHub Actions OIDC provider — the single most common OIDCProvider in the wild.
new CfnOIDCProvider(stack, "GitHubOidc", {
  url: "https://token.actions.githubusercontent.com",
  clientIdList: ["sts.amazonaws.com"],
  thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
});

// An EC2 instance profile wrapping a role.
const instanceRole = new Role(stack, "InstanceRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  description: "cdk-real-drift instance-profile integration test role",
});
new CfnInstanceProfile(stack, "InstanceProfile", {
  roles: [instanceRole.roleName],
});

app.synth();

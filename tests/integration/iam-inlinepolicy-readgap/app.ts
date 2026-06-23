// CDK app for the cdk-real-drift iam-inlinepolicy-readgap integration test.
// AWS::IAM::RolePolicy and AWS::IAM::UserPolicy (the standalone L1 inline-policy
// resources) have COMPOSITE Cloud Control primaryIdentifiers — [PolicyName, RoleName]
// and [PolicyName, UserName] — but their CFn physical id is only the bare PolicyName.
// So like Logs SubscriptionFilter (PR #344), a declared inline policy is a CC
// ValidationException skip on every check (a read-gap) until a CC_IDENTIFIER_ADAPTERS
// entry pairs the PolicyName with its resolved parent. Zero-infra (just IAM), so this
// is the cheapest composite-identifier read-gap probe.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnRolePolicy,
  CfnUserPolicy,
  Role,
  ServicePrincipal,
  User,
} from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIamInlinepolicyReadgap");

const role = new Role(stack, "Role", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
});
new CfnRolePolicy(stack, "RolePol", {
  policyName: "cdkrd-inline-role",
  roleName: role.roleName,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["logs:CreateLogGroup"], Resource: "*" },
    ],
  },
});

const user = new User(stack, "User");
new CfnUserPolicy(stack, "UserPol", {
  policyName: "cdkrd-inline-user",
  userName: user.userName,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" },
    ],
  },
});

app.synth();

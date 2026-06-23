// cdk-real-drift IAM inline-Policies reorder + declared-PermissionsBoundary FP test.
// Headline bug (found by this fixture): an IAM principal's inline `Policies` is a SET
// of {PolicyName, PolicyDocument} AWS returns SORTED by PolicyName, not in template
// order — so a positional compare false-flags every shifted policy on a freshly
// recorded principal. The same shape lives on Role, User AND Group, so all three are
// declared here (non-alphabetical PolicyNames) to live-prove the whole class in one
// deploy. The Role also DECLARES a permissions boundary (a separate daily-driver
// surface whose only prior coverage was an out-of-band-attached boundary, a drift
// case). A freshly deployed + recorded stack with NO out-of-band change MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnGroup,
  CfnRole,
  CfnUser,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIamPermBoundaryRich");

// Two inline policies whose names are deliberately NON-alphabetical (readObjects
// before describeOnly) so AWS's sort-by-PolicyName reorder is revealed. The embedded
// `Policies` array is rendered identically on Role/User/Group.
const inlinePoliciesL1 = () => [
  {
    policyName: "readObjects",
    policyDocument: new PolicyDocument({
      statements: [
        new PolicyStatement({ actions: ["s3:GetObject", "s3:ListBucket"], resources: ["*"] }),
      ],
    }),
  },
  {
    policyName: "describeOnly",
    policyDocument: new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ["ec2:DescribeInstances", "ec2:DescribeTags"],
          resources: ["*"],
        }),
      ],
    }),
  },
];

// Role L2 keeps the declared permissions-boundary surface (RoleProps.inlinePolicies
// IS a real prop, but use the same L1 shape via addPropertyOverride for parity).
const role = new Role(stack, "BoundedRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  path: "/cdkrd/",
  description: "cdkrd iam-permboundary-rich test role",
  permissionsBoundary: ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"),
});
(role.node.defaultChild as CfnRole).policies = inlinePoliciesL1();

// User and Group: the embedded inline `Policies` array is only produced by the L1
// constructs (UserProps/GroupProps have no inlinePolicies prop — see hunt notes).
new CfnUser(stack, "InlineUser", { path: "/cdkrd/", policies: inlinePoliciesL1() });
new CfnGroup(stack, "InlineGroup", { path: "/cdkrd/", policies: inlinePoliciesL1() });

app.synth();

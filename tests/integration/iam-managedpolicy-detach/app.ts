// CDK app for the cdk-real-drift IAM ManagedPolicy ATTACHMENT-DETACH integration
// test (real AWS, AWS-mutating). Proves the asymmetric subset detach detection in
// ISOLATION: the policy is attached to roles created OUTSIDE this stack (passed by
// ARN via context), so there is no in-stack role resource whose own
// `ManagedPolicyArns` would mirror the same attachment and muddy the assertions.
//   - `declaredRoleArn` is declared in the ManagedPolicy's `Roles` list.
//   - `unionRoleArn` is attached out of band by verify-detect.sh (NOT in the
//     template) — the live UNION member that must NEVER false-drift.
import { App, Stack } from "aws-cdk-lib";
import { ManagedPolicy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIamManagedPolicyDetach");

const declaredRoleArn = stack.node.tryGetContext("declaredRoleArn") as string;
if (!declaredRoleArn) throw new Error("pass -c declaredRoleArn=<arn>");

const declaredRole = Role.fromRoleArn(stack, "DeclaredRole", declaredRoleArn);

new ManagedPolicy(stack, "Shared", {
  roles: [declaredRole],
  statements: [
    new PolicyStatement({
      sid: "ListAnything",
      actions: ["s3:ListAllMyBuckets"],
      resources: ["*"],
    }),
  ],
});

app.synth();

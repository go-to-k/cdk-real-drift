// Minimal CDK app for the cdk-real-drift `added` integ test on Cognito user pool GROUPS
// (a SECOND child type under the same AWS::Cognito::UserPool parent — alongside clients).
// A UserPool with ONE declared UserPoolGroup. verify.sh then `create-group`s additional
// groups on the SAME pool out of band (via the AWS CLI) — whole UserPoolGroup resources
// not in the template — and asserts cdkrd reports them under [Not Recorded] (PR4: an
// unrecorded added resource is inventory, not drift), records + watches them, and can
// revert (delete) them.
//
// IMPORTANT: a CDK UserPool DEFAULTS to RemovalPolicy.RETAIN, which would ORPHAN the pool
// (and bill) on teardown. We force RemovalPolicy.DESTROY so delstack / cdk destroy deletes
// it. Deleting a UserPool CASCADES its groups, so there are no stack-external orphans.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnUserPoolGroup, UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkrdIntegUserPoolGroupAdded");

const pool = new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
});

// Declared group — must NOT flag.
new CfnUserPoolGroup(stack, "DeclaredGroup", {
  userPoolId: pool.userPoolId,
  groupName: "declared-group",
});

app.synth();

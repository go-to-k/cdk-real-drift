// Minimal CDK app for the cdk-real-drift `added` integ test on Cognito user pool RESOURCE
// SERVERS (a THIRD child type under the same AWS::Cognito::UserPool parent — alongside
// clients and groups). A UserPool with ONE declared UserPoolResourceServer. verify.sh then
// `create-resource-server`s additional resource servers on the SAME pool out of band (via
// the AWS CLI) — whole UserPoolResourceServer resources not in the template — and asserts
// cdkrd reports them under [Not Recorded] (PR4: an unrecorded added resource is inventory,
// not drift), records + watches them, and can revert (delete) them.
//
// IMPORTANT: a CDK UserPool DEFAULTS to RemovalPolicy.RETAIN, which would ORPHAN the pool
// (and bill) on teardown. We force RemovalPolicy.DESTROY so delstack / cdk destroy deletes
// it. Deleting a UserPool CASCADES its resource servers, so there are no stack-external
// orphans.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnUserPoolResourceServer, UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkrdIntegUserPoolResourceServerAdded");

const pool = new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
});

// Declared resource server — must NOT flag.
new CfnUserPoolResourceServer(stack, "DeclaredRs", {
  userPoolId: pool.userPoolId,
  identifier: "https://declared.cdkrd.example",
  name: "declared",
});

app.synth();

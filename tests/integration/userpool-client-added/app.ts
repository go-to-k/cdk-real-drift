// Minimal CDK app for the cdk-real-drift `added` integ test on Cognito (the SIXTH
// CHILD_ENUMERATORS member). A UserPool with ONE declared UserPoolClient. verify.sh then
// `create-user-pool-client`s additional clients on the SAME pool out of band (via the AWS
// CLI) — whole UserPoolClient resources not in the template — and asserts cdkrd reports
// them under [Not Recorded] (PR4: an unrecorded added resource is inventory, not drift),
// records + watches them, and can revert (delete) them.
//
// IMPORTANT: a CDK UserPool DEFAULTS to RemovalPolicy.RETAIN, which would ORPHAN the pool
// (and bill) on teardown. We force RemovalPolicy.DESTROY so delstack / cdk destroy deletes
// it. Deleting a UserPool CASCADES its clients, so there are no stack-external orphans.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkrdIntegUserPoolClientAdded");

const pool = new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
});

pool.addClient("DeclaredClient"); // declared client — must NOT flag

app.synth();

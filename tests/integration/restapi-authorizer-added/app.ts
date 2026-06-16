// Minimal CDK app for the cdk-real-drift `added` (out-of-band resource) integ test
// covering API Gateway REST API AUTHORIZERS (an extension of the RestApi child
// enumerator). A REST API with one method (so it deploys), a small Lambda, and a
// DECLARED TOKEN authorizer backed by that Lambda. verify.sh then creates an
// undeclared authorizer on the SAME api out of band (via the AWS CLI) — a whole
// resource not in the template — and asserts cdkrd reports EXACTLY that one, while
// the DECLARED authorizer is NOT flagged (the false-positive guard). `cdk drift` /
// CFn drift detection miss this (they only compare template-declared resources).
import { App, Stack } from "aws-cdk-lib";
import { RestApi, TokenAuthorizer } from "aws-cdk-lib/aws-apigateway";
import { Code, Function as Fn, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkrdIntegRestApiAuthorizerAdded");
const api = new RestApi(stack, "Api");
const authFn = new Fn(stack, "AuthFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler=async()=>({})"),
});
const authorizer = new TokenAuthorizer(stack, "DeclaredAuth", { handler: authFn });
// Attach the authorizer to a method so CDK/CFn actually provisions it (an unattached
// authorizer can be dropped); this is the declared authorizer the test must NOT flag.
api.root.addMethod("GET", undefined, { authorizer });
app.synth();

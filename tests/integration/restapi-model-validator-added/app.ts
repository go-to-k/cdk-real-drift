// Minimal CDK app for the cdk-real-drift `added` (out-of-band resource) integ test
// covering API Gateway REST API MODELS + REQUEST VALIDATORS (an extension of the
// RestApi child enumerator, which already covers Resources + Methods + Authorizers).
// A REST API with one method (so it deploys), one DECLARED Model, and one DECLARED
// RequestValidator. verify.sh then creates an undeclared model AND an undeclared
// request validator on the SAME api out of band (via the AWS CLI) — whole resources
// not in the template — and asserts cdkrd reports EXACTLY those, while the DECLARED
// ones (and the built-in `Empty`/`Error` default models, after `record`) are NOT
// flagged. `cdk drift` / CFn drift detection miss this (template-only comparison).
import { App, Stack } from "aws-cdk-lib";
import {
  JsonSchemaType,
  JsonSchemaVersion,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkrdIntegRestApiModelValidatorAdded");
const api = new RestApi(stack, "Api");
api.root.addMethod("GET");
api.addModel("DeclaredModel", {
  contentType: "application/json",
  schema: {
    schema: JsonSchemaVersion.DRAFT4,
    title: "decl",
    type: JsonSchemaType.OBJECT,
  },
});
api.addRequestValidator("DeclaredValidator", { validateRequestBody: true });
app.synth();

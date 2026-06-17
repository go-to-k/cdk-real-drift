// Minimal CDK app for the cdk-real-drift `added` (out-of-band resource) integ test
// covering API Gateway REST API GATEWAY RESPONSES (an extension of the RestApi child
// enumerator, which already covers Resources + Methods + Authorizers + Models +
// RequestValidators). A REST API with one method (so it deploys) and one DECLARED
// GatewayResponse (DEFAULT_4XX). verify.sh then customizes an undeclared gateway
// response (DEFAULT_5XX) on the SAME api out of band (via the AWS CLI) — a whole
// resource not in the template — and asserts cdkrd reports EXACTLY that, while the
// DECLARED one (and the ~17 API Gateway-generated un-customized defaults, thanks to the
// `defaultResponse: false` filter) is NOT flagged. `cdk drift` / CFn drift detection
// miss this (template-only comparison).
import { App, Stack } from "aws-cdk-lib";
import { GatewayResponse, ResponseType, RestApi } from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkrdIntegRestApiGatewayResponseAdded");
const api = new RestApi(stack, "Api");
api.root.addMethod("GET");
new GatewayResponse(stack, "DeclaredGr", {
  restApi: api,
  type: ResponseType.DEFAULT_4XX,
  statusCode: "444",
});
app.synth();

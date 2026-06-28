// CDK app for the cdk-real-drift ApiGateway Method Integration-knob integration test.
// A REST API with a single GET method backed by a MOCK integration that has one
// integration response (statusCode 200). The template declares NEITHER the integration's
// PassthroughBehavior/ContentHandling NOR the integration response's SelectionPattern/
// ContentHandling — so verify.sh sets them OUT OF BAND and asserts:
//   - they are DETECTED as undeclared drift (the array-element ones inside
//     IntegrationResponses[200] were a silent FN before — the array is keyed by StatusCode,
//     which is not a generic IDENTITY_FIELD, so it was never descended);
//   - they are SURFACED in the default report (not folded into the undeclared-subkey count);
//   - reverting them RESETS each knob via the API Gateway SDK writer (UpdateIntegration /
//     UpdateIntegrationResponse PatchOperations) — PassthroughBehavior back to its default,
//     SelectionPattern / ContentHandling removed.
import { App, Stack } from "aws-cdk-lib";
import { MockIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegApigwMethod");
const api = new RestApi(stack, "Api", { cloudWatchRole: false });
// PassthroughBehavior / ContentHandling / SelectionPattern are deliberately NOT declared —
// CDK omits them from the template, so out-of-band sets surface as UNDECLARED drift.
api.root.addMethod(
  "GET",
  new MockIntegration({
    requestTemplates: { "application/json": '{"statusCode": 200}' },
    integrationResponses: [{ statusCode: "200" }],
  }),
  { methodResponses: [{ statusCode: "200" }] }
);
app.synth();

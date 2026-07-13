// CDK app for the cdk-real-drift wsapi-hunt false-positive integration test.
// First live exercise of a WEBSOCKET ApiGatewayV2 Api and, critically, of the
// AWS::ApiGatewayV2::IntegrationResponse and AWS::ApiGatewayV2::RouteResponse
// composite-identifier adapters — both have zero corpus cases and zero fixtures,
// so their CC_IDENTIFIER_ADAPTERS paths have never run against real AWS. A clean
// first `check` (before `record`) must show ZERO potential drift.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApi,
  CfnIntegration,
  CfnIntegrationResponse,
  CfnRoute,
  CfnRouteResponse,
  CfnStage,
} from "aws-cdk-lib/aws-apigatewayv2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntWsApi0713");

const api = new CfnApi(stack, "WsApi", {
  name: "cdkrd-hunt-ws-0713",
  protocolType: "WEBSOCKET",
  routeSelectionExpression: "$request.body.action",
});

const integration = new CfnIntegration(stack, "WsInteg", {
  apiId: api.ref,
  integrationType: "MOCK",
  requestTemplates: { "200": '{"statusCode":200}' },
  templateSelectionExpression: "200",
});

new CfnIntegrationResponse(stack, "WsIntegResp", {
  apiId: api.ref,
  integrationId: integration.ref,
  integrationResponseKey: "$default",
});

const route = new CfnRoute(stack, "WsRoute", {
  apiId: api.ref,
  routeKey: "$default",
  target: `integrations/${integration.ref}`,
  routeResponseSelectionExpression: "$default",
});

new CfnRouteResponse(stack, "WsRouteResp", {
  apiId: api.ref,
  routeId: route.ref,
  routeResponseKey: "$default",
});

new CfnStage(stack, "WsStage", {
  apiId: api.ref,
  stageName: "hunt",
});

app.synth();

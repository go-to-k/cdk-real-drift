// Adapter probe (real AWS): AWS::ApiGatewayV2::Model and ::Deployment have
// CC_IDENTIFIER_ADAPTERS entries (composite ApiId|child id) but ZERO corpus and
// ZERO fixture coverage — a wrong adapter order silently skips every read (the
// #1523 class). Deploys a barest WebSocket API with a Model + an explicit
// Deployment (+ the Lambda integration a deployable route requires) and asserts
// the first check is CLEAN with nothing skipped.
// (ApiMapping / v1 BasePathMapping need an ACM cert + custom domain — deferred.)
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApi,
  CfnDeployment,
  CfnIntegration,
  CfnModel,
  CfnRoute,
  CfnStage,
} from "aws-cdk-lib/aws-apigatewayv2";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnFunction, CfnPermission } from "aws-cdk-lib/aws-lambda";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714WsExt");

const api = new CfnApi(stack, "HuntWsApi", {
  name: "cdkrd-hunt0714-ws",
  protocolType: "WEBSOCKET",
  routeSelectionExpression: "$request.body.action",
});

const fnRole = new Role(stack, "HuntWsFnRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
});
const fn = new CfnFunction(stack, "HuntWsFn", {
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: fnRole.roleArn,
});
new CfnPermission(stack, "HuntWsPerm", {
  action: "lambda:InvokeFunction",
  functionName: fn.ref,
  principal: "apigateway.amazonaws.com",
});

const integration = new CfnIntegration(stack, "HuntWsIntegration", {
  apiId: api.ref,
  integrationType: "AWS_PROXY",
  integrationUri: `arn:aws:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${fn.attrArn}/invocations`,
});

const route = new CfnRoute(stack, "HuntWsRoute", {
  apiId: api.ref,
  routeKey: "$connect",
  target: `integrations/${integration.ref}`,
});

new CfnModel(stack, "HuntWsModel", {
  apiId: api.ref,
  name: "HuntModel",
  contentType: "application/json",
  schema: {
    $schema: "http://json-schema.org/draft-04/schema#",
    title: "HuntModel",
    type: "object",
  },
});

const deployment = new CfnDeployment(stack, "HuntWsDeployment", {
  apiId: api.ref,
});
deployment.addDependency(route);

new CfnStage(stack, "HuntWsStage", {
  apiId: api.ref,
  stageName: "hunt",
  deploymentId: deployment.ref,
});

app.synth();

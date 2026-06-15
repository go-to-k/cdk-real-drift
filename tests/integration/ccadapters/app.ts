// cdk-real-drift CC-identifier-adapter integration fixture — R129.
// These composite-identifier types are CC ValidationException skips when read with
// the bare CFn physical id; the R129 CC_IDENTIFIER_ADAPTERS pair each with its parent
// (or, for Deployment, child-first) so Cloud Control reads them. ApiGateway v1
// Model / RequestValidator / Resource / Stage / Deployment + Cognito UserPoolDomain /
// UserPoolResourceServer. verify-ccadapters.sh asserts these now READ (no CC
// ValidationException skip) AND a fresh deploy has ZERO declared drift.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  JsonSchemaType,
  JsonSchemaVersion,
  MockIntegration,
  PassthroughBehavior,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { ResourceServerScope, UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegCcAdapters");

const api = new RestApi(stack, "RestApi", { restApiName: "cdkrd-ccadapters-api" });
const res = api.root.addResource("items");
res.addMethod(
  "GET",
  new MockIntegration({
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: { "application/json": '{"statusCode": 200}' },
    integrationResponses: [{ statusCode: "200" }],
  }),
  { methodResponses: [{ statusCode: "200" }] }
);
api.addModel("Model", {
  contentType: "application/json",
  modelName: "CdkrdProbeModel",
  schema: {
    schema: JsonSchemaVersion.DRAFT4,
    title: "p",
    type: JsonSchemaType.OBJECT,
    properties: { id: { type: JsonSchemaType.STRING } },
  },
});
api.addRequestValidator("Validator", {
  requestValidatorName: "cdkrd-probe-validator",
  validateRequestBody: true,
});

const userPool = new UserPool(stack, "UserPool", {
  userPoolName: "cdkrd-probe-pool",
  removalPolicy: RemovalPolicy.DESTROY,
});
userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: "cdkrd-ccadapters-domain" } });
userPool.addResourceServer("ResourceServer", {
  identifier: "cdkrd-probe-rs",
  scopes: [new ResourceServerScope({ scopeName: "read", scopeDescription: "r" })],
});

app.synth();

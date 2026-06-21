// CDK app for the cdk-real-drift REST API Lambda-authorizer false-positive +
// read-gap test. A Lambda (custom) authorizer on a REST API is a very common auth
// pattern, but a DECLARED AWS::ApiGateway::Authorizer has never been read via the
// normal CC path (the existing restapi-authorizer-added fixture exercises only the
// out-of-band `added`-tier enumerator). Its CC primaryIdentifier is the composite
// [RestApiId, AuthorizerId] while the CFn physical id is the bare AuthorizerId, so
// without a CC_IDENTIFIER_ADAPTERS entry it is silently `skipped`. A freshly deployed
// + recorded API with NO out-of-band change MUST report CLEAN — and the Authorizer
// MUST be read (skipped=0).
import { App, Duration, Stack } from "aws-cdk-lib";
import {
  MockIntegration,
  PassthroughBehavior,
  RestApi,
  TokenAuthorizer,
} from "aws-cdk-lib/aws-apigateway";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRestApiAuthorizerRich");

const authFn = new Function(stack, "AuthFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline(
    "exports.handler = async () => ({ principalId: 'u', policyDocument: {} });"
  ),
});

const api = new RestApi(stack, "Api");

const authorizer = new TokenAuthorizer(stack, "Authorizer", {
  handler: authFn,
  identitySource: "method.request.header.Authorization",
  resultsCacheTtl: Duration.minutes(5),
});

api.root.addMethod(
  "GET",
  new MockIntegration({
    integrationResponses: [{ statusCode: "200" }],
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: { "application/json": '{"statusCode": 200}' },
  }),
  { authorizer, methodResponses: [{ statusCode: "200" }] }
);

app.synth();

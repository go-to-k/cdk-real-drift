// CDK app for the cdk-real-drift HTTP API (v2) JWT-authorizer false-positive +
// read-gap test. A JWT authorizer on an HTTP API is a very common auth pattern, but
// a DECLARED AWS::ApiGatewayV2::Authorizer has never been read via the normal CC
// path. Its CC primaryIdentifier is the composite [AuthorizerId, ApiId] — CHILD
// first, the REVERSE of the REST authorizer's [RestApiId, AuthorizerId] — while the
// CFn physical id is the bare AuthorizerId, so without a CC_IDENTIFIER_ADAPTERS entry
// it is silently `skipped`. The authorizer also carries an IdentitySource array and a
// nested JwtConfiguration (Issuer + Audience array). A freshly deployed + recorded API
// with NO out-of-band change MUST report CLEAN — and the Authorizer MUST be read
// (skipped=0).
import { App, Stack } from "aws-cdk-lib";
import { CfnAuthorizer, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegHttpApiAuthorizerRich");

const api = new HttpApi(stack, "Api");

new CfnAuthorizer(stack, "Authorizer", {
  apiId: api.apiId,
  authorizerType: "JWT",
  name: "cdkrd-jwt-auth",
  identitySource: ["$request.header.Authorization"],
  jwtConfiguration: {
    // A real OIDC issuer is required: API Gateway validates the issuer's
    // /.well-known/openid-configuration discovery endpoint at create time.
    issuer: "https://accounts.google.com",
    audience: ["cdkrd-audience"],
  },
});

app.synth();

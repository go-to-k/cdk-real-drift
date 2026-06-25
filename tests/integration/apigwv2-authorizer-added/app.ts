// Minimal CDK app for the cdk-real-drift `added` integ test on API Gateway V2
// Authorizers (extending the SECOND CHILD_ENUMERATORS member, AWS::ApiGatewayV2::Api,
// to also enumerate AWS::ApiGatewayV2::Authorizer). An HTTP API with ONE declared JWT
// authorizer. verify.sh then creates an Authorizer out of band (via the AWS CLI) — a
// whole resource not in the template — and asserts cdkrd reports it under
// [Potential Drift] (PR4: an unrecorded added resource is inventory, not drift), records +
// watches it, and can revert (delete) it. The declared authorizer must NOT be flagged.
// L1 (Cfn*) constructs are used so the fixture needs no alpha integrations module; a JWT
// authorizer needs no backing Lambda, keeping the fixture self-contained. The issuer is
// a REAL public OIDC provider (Google) because both the CFn handler and the
// apigatewayv2 create-authorizer API validate the issuer's `/.well-known/
// openid-configuration` discovery endpoint at create time — a placeholder like
// `https://example.com/` is rejected with BadRequestException.
import { App, Stack } from "aws-cdk-lib";
import { CfnApi, CfnAuthorizer } from "aws-cdk-lib/aws-apigatewayv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegApiGwV2AuthorizerAdded");

// No Stage on purpose: an AutoDeploy `$default` stage churns its undeclared
// `DeploymentId`, which would confound this test's `added`-resource assertions. The Api
// + Authorizer resources are enumerated regardless of a stage, so dropping it keeps the
// test on a single dimension.
const api = new CfnApi(stack, "Api", { name: "cdkrd-integ-v2-auth", protocolType: "HTTP" });
new CfnAuthorizer(stack, "DeclaredAuth", {
  apiId: api.ref,
  authorizerType: "JWT",
  name: "declared",
  identitySource: ["$request.header.Authorization"],
  jwtConfiguration: { issuer: "https://accounts.google.com", audience: ["cdkrd"] },
});

app.synth();

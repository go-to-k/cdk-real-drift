// Minimal CDK app for the cdk-real-drift `added` integ test on API Gateway V2 (the
// SECOND CHILD_ENUMERATORS member). An HTTP API with ONE declared route (GET /items)
// backed by an HTTP_PROXY integration. verify.sh then creates a Route + Integration
// out of band (via the AWS CLI) — whole resources not in the template — and asserts
// cdkrd reports them under [Potential Drift] (PR4: an unrecorded added resource is
// inventory, not drift), records + watches them, and can revert (delete) them.
// L1 (Cfn*) constructs are used so the fixture needs no alpha integrations module.
import { App, Stack } from "aws-cdk-lib";
import { CfnApi, CfnIntegration, CfnRoute } from "aws-cdk-lib/aws-apigatewayv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegApigwV2Added");

// No Stage on purpose: an AutoDeploy `$default` stage re-deploys whenever a route is
// added, churning the stage's undeclared `DeploymentId` (a real, correctly-detected
// undeclared drift) — which would confound this test's `added`-resource assertions.
// The Api + Route + Integration resources exist and are enumerated regardless of a
// stage, so dropping it keeps the test on a single dimension.
const api = new CfnApi(stack, "Api", { name: "cdkrd-integ-v2", protocolType: "HTTP" });
const integration = new CfnIntegration(stack, "Integration", {
  apiId: api.ref,
  integrationType: "HTTP_PROXY",
  integrationUri: "https://example.com",
  integrationMethod: "GET",
  payloadFormatVersion: "1.0",
});
new CfnRoute(stack, "Route", {
  apiId: api.ref,
  routeKey: "GET /items",
  target: `integrations/${integration.ref}`,
});

app.synth();

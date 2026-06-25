// Minimal CDK app for the cdk-real-drift `added` integ test on API Gateway V2
// Stages (extending the SECOND CHILD_ENUMERATORS member, AWS::ApiGatewayV2::Api,
// to also enumerate AWS::ApiGatewayV2::Stage). An HTTP API with ONE declared stage.
// verify.sh then creates a Stage out of band (via the AWS CLI) — a whole resource not
// in the template — and asserts cdkrd reports it under [Potential Drift] (PR4: an
// unrecorded added resource is inventory, not drift), records + watches it, and can
// revert (delete) it. The declared stage must NOT be flagged.
// L1 (Cfn*) constructs are used so the fixture needs no alpha integrations module.
import { App, Stack } from "aws-cdk-lib";
import { CfnApi, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegApiGwV2StageAdded");

// The declared stage has NO autoDeploy on purpose: an AutoDeploy stage churns its
// undeclared `DeploymentId`, which would confound this test's `added`-resource
// assertions. The Api + Stage resources are enumerated regardless.
const api = new CfnApi(stack, "Api", { name: "cdkrd-integ-v2-stage", protocolType: "HTTP" });
new CfnStage(stack, "DeclaredStage", { apiId: api.ref, stageName: "prod" });

app.synth();

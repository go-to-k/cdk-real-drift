// cdk-real-drift corpus-harvest wave 8 (real AWS) — R90.
// More uncovered CFn types, several as children of a covered parent (ApiGateway
// RestApi children; a Cognito resource server) plus standalone DNS-firewall, OIDC
// provider, and public ECR repo. Same harvest invariants as wave 7.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  GatewayResponse,
  JsonSchemaType,
  MockIntegration,
  Model,
  RequestValidator,
  ResponseType,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { ResourceServerScope, UserPool, UserPoolResourceServer } from "aws-cdk-lib/aws-cognito";
import { CfnPublicRepository } from "aws-cdk-lib/aws-ecr";
import { CfnOIDCProvider } from "aws-cdk-lib/aws-iam";
import { CfnFirewallDomainList, CfnFirewallRuleGroup } from "aws-cdk-lib/aws-route53resolver";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest8");

// ApiGateway RestApi (covered) carrying NEW child types: Model, RequestValidator,
// GatewayResponse (+ the Deployment/Stage CDK adds for a RestApi).
const api = new RestApi(stack, "Api", { restApiName: "cdkrd-integ-api" });
api.root.addMethod(
  "GET",
  new MockIntegration({
    integrationResponses: [{ statusCode: "200" }],
    requestTemplates: { "application/json": '{"statusCode": 200}' },
  }),
  { methodResponses: [{ statusCode: "200" }] },
);
new Model(stack, "Model", {
  restApi: api,
  contentType: "application/json",
  modelName: "cdkrdModel",
  schema: { type: JsonSchemaType.OBJECT },
});
new RequestValidator(stack, "Validator", { restApi: api, validateRequestBody: true });
new GatewayResponse(stack, "GwResponse", { restApi: api, type: ResponseType.DEFAULT_4XX });

// Cognito resource server (the UserPool itself is already covered).
const pool = new UserPool(stack, "Pool8", { removalPolicy: RemovalPolicy.DESTROY });
new UserPoolResourceServer(stack, "ResourceServer", {
  userPool: pool,
  identifier: "cdkrd-api",
  scopes: [new ResourceServerScope({ scopeName: "read", scopeDescription: "read access" })],
});

// Route53 Resolver DNS firewall.
const fwDomains = new CfnFirewallDomainList(stack, "FwDomains", {
  name: "cdkrd-integ-fw",
  domains: ["example.com", "test.example.org"],
});
new CfnFirewallRuleGroup(stack, "FwRuleGroup", {
  name: "cdkrd-integ-frg",
  firewallRules: [
    {
      action: "BLOCK",
      blockResponse: "NODATA",
      firewallDomainListId: fwDomains.attrId,
      priority: 100,
    },
  ],
});

// IAM OIDC provider (L1 with an explicit thumbprint, so no network fetch and a
// fake url that cannot collide with a real provider in the account).
new CfnOIDCProvider(stack, "Oidc", {
  url: "https://oidc.cdkrd-integ-test.example.com",
  clientIdList: ["sts.amazonaws.com"],
  thumbprintList: ["9e99a48a9960b14926bb7f3b02e22da2b0ab7280"],
});

// Public ECR repository (us-east-1 only).
new CfnPublicRepository(stack, "PublicRepo", { repositoryName: "cdkrd-integ-pub" });

app.synth();

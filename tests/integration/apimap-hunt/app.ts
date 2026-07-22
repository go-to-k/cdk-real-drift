// Unexercised-adapter probe (real AWS): AWS::ApiGatewayV2::ApiMapping
// (child-first composite `ApiMappingId|DomainName`) and
// AWS::ApiGateway::BasePathMapping (compositeWith DomainName) both have
// CC_IDENTIFIER_ADAPTERS entries with zero corpus and zero fixtures — deferred
// by past hunts because they need a custom domain + ACM cert. A SELF-SIGNED
// IMPORTED cert (out-of-band by verify.sh, CERT_ARN env) unblocks both:
// API Gateway regional domains accept imported certs and never touch DNS.
// Both mapping parents (HTTP API $default stage; REST API prod stage) are the
// barest possible forms.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnBasePathMapping,
  CfnDeployment,
  CfnDomainName as CfnRestDomainName,
  CfnMethod,
  CfnResource as CfnApiResource,
  CfnRestApi,
  CfnStage,
} from "aws-cdk-lib/aws-apigateway";
import {
  CfnApi,
  CfnApiMapping,
  CfnDomainName,
  CfnStage as CfnV2Stage,
} from "aws-cdk-lib/aws-apigatewayv2";

const certArn = process.env.CERT_ARN;
if (!certArn) throw new Error("CERT_ARN env is required (set by verify.sh)");
const domainV2 = "hunt0722-v2.cdkrd-hunt.example.com";
const domainV1 = "hunt0722-v1.cdkrd-hunt.example.com";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722ApiMap");

// ---- HTTP API + $default stage + domain + ApiMapping
const httpApi = new CfnApi(stack, "HuntHttpApi", {
  name: "cdkrd-hunt0722-apimap-http",
  protocolType: "HTTP",
});
const v2Stage = new CfnV2Stage(stack, "HuntHttpStage", {
  apiId: httpApi.ref,
  stageName: "$default",
  autoDeploy: true,
});
const v2Domain = new CfnDomainName(stack, "HuntV2Domain", {
  domainName: domainV2,
  domainNameConfigurations: [
    { certificateArn: certArn, endpointType: "REGIONAL" },
  ],
});
const apiMapping = new CfnApiMapping(stack, "HuntApiMapping", {
  apiId: httpApi.ref,
  domainName: v2Domain.ref,
  stage: "$default",
});
apiMapping.addDependency(v2Stage);

// ---- REST API + prod stage + domain + BasePathMapping
const restApi = new CfnRestApi(stack, "HuntRestApi", {
  name: "cdkrd-hunt0722-apimap-rest",
});
const pingResource = new CfnApiResource(stack, "HuntPing", {
  restApiId: restApi.ref,
  parentId: restApi.attrRootResourceId,
  pathPart: "ping",
});
const pingMethod = new CfnMethod(stack, "HuntPingGet", {
  restApiId: restApi.ref,
  resourceId: pingResource.ref,
  httpMethod: "GET",
  authorizationType: "NONE",
  integration: { type: "MOCK", requestTemplates: { "application/json": '{"statusCode": 200}' } },
});
const deployment = new CfnDeployment(stack, "HuntDeployment", {
  restApiId: restApi.ref,
});
deployment.addDependency(pingMethod);
const restStage = new CfnStage(stack, "HuntRestStage", {
  restApiId: restApi.ref,
  deploymentId: deployment.ref,
  stageName: "prod",
});
const restDomain = new CfnRestDomainName(stack, "HuntRestDomain", {
  domainName: domainV1,
  regionalCertificateArn: certArn,
  endpointConfiguration: { types: ["REGIONAL"] },
});
const bpm = new CfnBasePathMapping(stack, "HuntBasePathMapping", {
  domainName: restDomain.ref,
  restApiId: restApi.ref,
  stage: "prod",
});
bpm.addDependency(restStage);

app.synth();

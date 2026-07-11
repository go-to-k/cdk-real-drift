// CDK app for the cdk-real-drift reorder-probes-min false-positive integration
// test. DECLARED-dimension set-reorder probes: each declares a multi-element
// list in a deliberately NON-canonical (non-sorted) order on types whose
// live read is suspected to canonicalize/sort it, but whose trigger no corpus
// case exercises (all existing cases have 0-1 elements or sorted order):
// - AWS::Cognito::IdentityPool CognitoIdentityProviders (2 providers, reversed)
// - AWS::ECS::Cluster CapacityProviders + DefaultCapacityProviderStrategy
//   (FARGATE_SPOT before FARGATE)
// - AWS::ApiGateway::RestApi BinaryMediaTypes (3 entries, non-alphabetical)
// - AWS::ApiGatewayV2::Api CorsConfiguration.AllowOrigins (3, non-sorted)
// - AWS::EFS::FileSystem LifecyclePolicies (3 single-key unions, non-canonical)
// A declared-tier drift on the un-mutated deploy = normalization FP.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnApi } from "aws-cdk-lib/aws-apigatewayv2";
import { CfnRestApi } from "aws-cdk-lib/aws-apigateway";
import { CfnIdentityPool, CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { CfnCluster } from "aws-cdk-lib/aws-ecs";
import { CfnFileSystem } from "aws-cdk-lib/aws-efs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegReorderProbesMin");

const pool = new CfnUserPool(stack, "HuntPool", {
  userPoolName: "cdkrd-hunt-reorder-pool",
});
const clientB = new CfnUserPoolClient(stack, "HuntClientB", {
  userPoolId: pool.ref,
  clientName: "cdkrd-hunt-client-b",
});
const clientA = new CfnUserPoolClient(stack, "HuntClientA", {
  userPoolId: pool.ref,
  clientName: "cdkrd-hunt-client-a",
});

new CfnIdentityPool(stack, "HuntIdPool", {
  identityPoolName: "cdkrd-hunt-reorder-idpool",
  allowUnauthenticatedIdentities: false,
  cognitoIdentityProviders: [
    { providerName: `cognito-idp.${stack.region}.amazonaws.com/${pool.ref}`, clientId: clientB.ref },
    { providerName: `cognito-idp.${stack.region}.amazonaws.com/${pool.ref}`, clientId: clientA.ref },
  ],
});

new CfnCluster(stack, "HuntEcsCluster", {
  clusterName: "cdkrd-hunt-reorder-cluster",
  capacityProviders: ["FARGATE_SPOT", "FARGATE"],
  defaultCapacityProviderStrategy: [
    { capacityProvider: "FARGATE_SPOT", weight: 2 },
    { capacityProvider: "FARGATE", weight: 1, base: 1 },
  ],
});

new CfnRestApi(stack, "HuntRestApi", {
  name: "cdkrd-hunt-reorder-restapi",
  binaryMediaTypes: ["image/webp", "application/octet-stream", "image/avif"],
});

new CfnApi(stack, "HuntHttpApi", {
  name: "cdkrd-hunt-reorder-httpapi",
  protocolType: "HTTP",
  corsConfiguration: {
    allowOrigins: ["https://z.example.org", "https://a.example.org", "https://m.example.org"],
    allowMethods: ["POST", "GET"],
  },
});

new CfnFileSystem(stack, "HuntEfs", {
  throughputMode: "elastic",
  lifecyclePolicies: [
    { transitionToPrimaryStorageClass: "AFTER_1_ACCESS" },
    { transitionToArchive: "AFTER_90_DAYS" },
    { transitionToIa: "AFTER_30_DAYS" },
  ],
});

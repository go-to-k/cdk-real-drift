// CDK app for the cdk-real-drift privapi-misc-min false-positive integration test.
// BAREST-possible configs for uncovered variants / types:
// - AWS::ApiGateway::RestApi with EndpointConfiguration PRIVATE (corpus covers
//   only EDGE/REGIONAL) + the required resource policy.
// - AWS::EC2::IPAMPool (+ its parent IPAM, advanced tier — see note below) —
//   base IPAM is covered, the pool is not.
// (AWS::AppMesh::Mesh was probed and DETERMINED OUT: Cloud Control has no read
// handler (UnsupportedActionException -> transparent `skipped`), and App Mesh
// reaches end-of-support 2026-09-30 — an SDK_OVERRIDES reader for an EOL service
// is not worth carrying, so the type is deliberately NOT in this fixture.)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyDocument, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnIPAM, CfnIPAMPool } from "aws-cdk-lib/aws-ec2";
import { EndpointType, MockIntegration, PassthroughBehavior, RestApi } from "aws-cdk-lib/aws-apigateway";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713bPrivApiMisc");

const api = new RestApi(stack, "HuntPrivateApi", {
  restApiName: "cdkrd-hunt-private-api",
  endpointConfiguration: { types: [EndpointType.PRIVATE] },
  policy: new PolicyDocument({
    statements: [
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
      }),
    ],
  }),
  deploy: false,
});
api.root.addMethod(
  "GET",
  new MockIntegration({
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: { "application/json": '{"statusCode": 200}' },
    integrationResponses: [{ statusCode: "200" }],
  }),
  { methodResponses: [{ statusCode: "200" }] },
);

// IPAM free tier REJECTS private-scope pool creation ("operation is not supported
// by your IPAM Tier", live-determined 2026-07-13) — the pool probe needs the
// advanced tier, which bills per ACTIVE IP only (an empty hunt pool costs ~$0 and
// is deleted with the stack).
const ipam = new CfnIPAM(stack, "HuntIpam", {
  tier: "advanced",
  operatingRegions: [{ regionName: "us-east-1" }],
});

new CfnIPAMPool(stack, "HuntIpamPool", {
  addressFamily: "ipv4",
  ipamScopeId: ipam.attrPrivateDefaultScopeId,
  locale: "us-east-1",
  provisionedCidrs: [{ cidr: "10.99.0.0/16" }],
});

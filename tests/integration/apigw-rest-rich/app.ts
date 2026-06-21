// CDK app for the cdk-real-drift apigw-rest-rich false-positive integration test.
// The existing apigw/restapi-* fixtures only exercise the `added` tier (out-of-band
// child resources). This one stresses the property-RICH RestApi body a large fraction
// of CDK users deploy: a REGIONAL endpoint configuration, binary media types, a
// minimum compression size, two MOCK-integrated methods, and a deployed Stage with
// X-Ray tracing + throttling MethodSettings. AWS folds the stage's MethodSettings
// ("*/*") and the endpoint config into its own model with defaults — a clean
// `record`->`check` is a strong false-positive oracle. MOCK integrations keep the
// stack Lambda-free (fast, no /aws/lambda/* orphan log group).
import { App, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import {
  EndpointType,
  MockIntegration,
  PassthroughBehavior,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegApigwRestRich");

const api = new RestApi(stack, "Api", {
  restApiName: "cdkrd-apigw-rest-rich",
  endpointConfiguration: { types: [EndpointType.REGIONAL] },
  binaryMediaTypes: ["application/octet-stream", "image/*"],
  minCompressionSize: Size.bytes(1024),
  deployOptions: {
    stageName: "prod",
    tracingEnabled: false,
    throttlingRateLimit: 100,
    throttlingBurstLimit: 50,
    description: "cdkrd integ stage",
  },
});
api.applyRemovalPolicy(RemovalPolicy.DESTROY);

const mock = new MockIntegration({
  integrationResponses: [{ statusCode: "200" }],
  passthroughBehavior: PassthroughBehavior.NEVER,
  requestTemplates: { "application/json": '{ "statusCode": 200 }' },
});

const items = api.root.addResource("items");
items.addMethod("GET", mock, { methodResponses: [{ statusCode: "200" }] });
items.addMethod("POST", mock, { methodResponses: [{ statusCode: "200" }] });

app.synth();

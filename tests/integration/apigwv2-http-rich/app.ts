// CDK app for the cdk-real-drift apigwv2-http-rich false-positive integration test.
// The existing apigwv2-* fixtures only exercise the `added` tier (out-of-band routes /
// integrations / stages). This one stresses the property-RICH HTTP Api body a large
// fraction of CDK users deploy: a CORS preflight config (origins / methods / headers /
// max-age), an API description, and a route backed by an HTTP_PROXY integration. AWS
// folds the CORS config + the auto-created $default stage into its own model with
// defaults — a clean `record`->`check` is a strong false-positive oracle.
import { App, Duration, Stack } from "aws-cdk-lib";
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUrlIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegApigwv2HttpRich");

const api = new HttpApi(stack, "Api", {
  apiName: "cdkrd-httpapi-rich",
  description: "cdkrd http api rich",
  corsPreflight: {
    allowOrigins: ["https://example.com"],
    allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: Duration.days(1),
  },
});

api.addRoutes({
  path: "/items",
  methods: [HttpMethod.GET],
  integration: new HttpUrlIntegration("ItemsProxy", "https://example.com"),
});

app.synth();

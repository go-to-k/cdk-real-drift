// CDK app for the cdk-real-drift events-apidest-rich false-positive integration test.
// EventBridge API Destinations (AWS::Events::Connection + AWS::Events::ApiDestination)
// are a common outbound-webhook integration. A Connection folds an AuthorizationType,
// nested AuthParameters (API-key), and an AWS-created SecretArn / State into AWS's
// model; an ApiDestination folds an InvocationRateLimitPerSecond default (300) that
// the template never declares. A clean `record`->`check` is a strong false-positive
// oracle for those undeclared, AWS-assigned values.
import { App, Stack } from "aws-cdk-lib";
import { CfnApiDestination, CfnConnection } from "aws-cdk-lib/aws-events";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEventsApiDestRich");

const connection = new CfnConnection(stack, "Connection", {
  name: "cdkrd-apidest-connection",
  description: "cdkrd api destination connection",
  authorizationType: "API_KEY",
  authParameters: {
    apiKeyAuthParameters: {
      apiKeyName: "x-api-key",
      apiKeyValue: "cdkrd-placeholder-key",
    },
    invocationHttpParameters: {
      headerParameters: [
        { key: "x-custom-header", value: "cdkrd", isValueSecret: false },
      ],
    },
  },
});

new CfnApiDestination(stack, "ApiDestination", {
  name: "cdkrd-apidest-rich",
  description: "cdkrd api destination",
  connectionArn: connection.attrArn,
  invocationEndpoint: "https://example.com/webhook",
  httpMethod: "POST",
  // InvocationRateLimitPerSecond deliberately NOT declared -> AWS defaults it to 300.
});

app.synth();

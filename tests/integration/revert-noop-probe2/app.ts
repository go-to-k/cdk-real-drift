// Round-4 revert-convergence (silent no-op) probe (2026-07-14 hunt, follow-up to
// #1580 / #1583): more common types with KNOWN_DEFAULTS-folded MUTABLE scalars
// whose revert must CONVERGE (not silently no-op):
//   - Lambda EventSourceMapping: Enabled / MaximumBatchingWindowInSeconds /
//     MaximumRetryAttempts / MaximumRecordAgeInSeconds (UpdateEventSourceMapping)
//   - ApiGatewayV2 Api: DisableExecuteApiEndpoint (UpdateApi)
//   - ApiGatewayV2 Route: AuthorizationType (UpdateRoute)
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { CfnFunction, CfnEventSourceMapping } from "aws-cdk-lib/aws-lambda";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnApi, CfnIntegration, CfnRoute } from "aws-cdk-lib/aws-apigatewayv2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntRevertNoop2x0714");

// --- SQS -> Lambda EventSourceMapping ---
const queue = new CfnQueue(stack, "Queue", {});
const lambdaRole = new CfnRole(stack, "LambdaRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  policies: [
    {
      policyName: "sqs",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: queue.attrArn,
          },
        ],
      },
    },
  ],
});
const fn = new CfnFunction(stack, "Fn", {
  code: { zipFile: "exports.handler = async () => 'ok';" },
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: lambdaRole.attrArn,
});
new CfnEventSourceMapping(stack, "Esm", {
  eventSourceArn: queue.attrArn,
  functionName: fn.ref,
});

// --- ApiGatewayV2 HTTP Api + Route (barest) ---
const httpApi = new CfnApi(stack, "HttpApi", {
  name: "cdkrd-noop2-api",
  protocolType: "HTTP",
});
const integration = new CfnIntegration(stack, "Integration", {
  apiId: httpApi.ref,
  integrationType: "HTTP_PROXY",
  integrationMethod: "GET",
  integrationUri: "https://example.com",
  payloadFormatVersion: "1.0",
});
new CfnRoute(stack, "Route", {
  apiId: httpApi.ref,
  routeKey: "GET /",
  target: `integrations/${integration.ref}`,
});

app.synth();

// Lambda function exercising rich config NOT in lambda-rich: a Layer (Layers is an
// order-significant ARN array — guarded by hasOrderSignificantId, so it must NOT be
// sorted), a dead-letter SQS queue, multiple env vars, and reserved concurrency.
// Common production Lambda settings; clean record->check is the FP oracle.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Code, Function as LambdaFn, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaRichExtras");

const layer = new LayerVersion(stack, "Layer", {
  code: Code.fromAsset("layer"),
  compatibleRuntimes: [Runtime.NODEJS_20_X],
  removalPolicy: RemovalPolicy.DESTROY,
});

const dlq = new Queue(stack, "Dlq", { retentionPeriod: Duration.days(14) });

new LambdaFn(stack, "Fn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => 'ok';"),
  layers: [layer],
  deadLetterQueue: dlq,
  environment: { STAGE: "prod", REGION_HINT: "us-east-1", FEATURE_X: "on" },
  reservedConcurrentExecutions: 2,
});

app.synth();

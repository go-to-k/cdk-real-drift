// CDK app for the cdk-real-drift richly-configured Lambda false-positive test.
// Lambda is among the most commonly deployed CDK resources. This exercises the
// common "production" knobs at once: arm64 architecture, environment variables,
// X-Ray active tracing, ephemeral storage, reserved concurrency, an explicit log
// group with retention, and a Function URL with CORS. A freshly deployed +
// recorded function with NO out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  HttpMethod,
  Runtime,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaRich");

const logGroup = new LogGroup(stack, "Logs", {
  retention: RetentionDays.TWO_WEEKS,
  removalPolicy: RemovalPolicy.DESTROY,
});

const fn = new LambdaFunction(stack, "Handler", {
  runtime: Runtime.NODEJS_20_X,
  architecture: Architecture.ARM_64,
  handler: "index.handler",
  code: Code.fromInline("export const handler = async () => ({ ok: true });"),
  memorySize: 256,
  timeout: Duration.seconds(15),
  ephemeralStorageSize: Size.mebibytes(1024),
  tracing: Tracing.ACTIVE,
  // NOTE: reservedConcurrentExecutions intentionally omitted — setting it is rejected in
  // regions/accounts at the small default Lambda concurrency limit (the deploy fails with
  // "decreases account's UnreservedConcurrentExecution below its minimum value of [10]",
  // wasting a paid deploy + delstack cycle). It exercises no cdkrd-specific fold — a plain
  // declared mutable prop — and verify-detect.sh mutates MemorySize/Timeout, so detection
  // coverage is unaffected. See #685.
  description: "cdkrd lambda-rich test handler",
  environment: {
    STAGE: "test",
    FEATURE_FLAG: "on",
  },
  logGroup,
});

fn.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: ["https://example.com"],
    allowedMethods: [HttpMethod.GET, HttpMethod.POST],
    allowedHeaders: ["content-type"],
    maxAge: Duration.minutes(5),
  },
});

app.synth();

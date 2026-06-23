// CDK app for the cdk-real-drift Lambda "modern config knobs" false-positive test.
// Lambda is the single most commonly deployed CDK resource, and these newer
// production knobs are NOT yet exercised by lambda-rich: SnapStart (Python 3.12),
// the structured LoggingConfig (JSON format + per-stream log levels + an explicit
// log group), RuntimeManagementConfig, and a dead-letter queue. Each of these is
// an enum- or nested-object-shaped property — exactly the shape that historically
// hides a normalization false positive (an enum echoed in a different case, a
// nested config the service default-fills). A freshly deployed + recorded function
// with NO out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  ApplicationLogLevel,
  Code,
  Function as LambdaFunction,
  LoggingFormat,
  Runtime,
  RuntimeManagementMode,
  SnapStartConf,
  SystemLogLevel,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaConfigRich");

const logGroup = new LogGroup(stack, "Logs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

const dlq = new Queue(stack, "Dlq", {
  retentionPeriod: Duration.days(7),
});

new LambdaFunction(stack, "Handler", {
  // SnapStart supports Java 11+, Python 3.12+, .NET 8+ — pin Python 3.12.
  runtime: Runtime.PYTHON_3_12,
  handler: "index.handler",
  code: Code.fromInline("def handler(event, context):\n    return {'ok': True}\n"),
  memorySize: 256,
  timeout: Duration.seconds(15),
  description: "cdkrd lambda-config-rich test handler",
  environment: {
    STAGE: "test",
    FEATURE_FLAG: "on",
  },
  // Structured JSON logging with per-stream levels + an explicit log group.
  loggingFormat: LoggingFormat.JSON,
  applicationLogLevelV2: ApplicationLogLevel.INFO,
  systemLogLevelV2: SystemLogLevel.WARN,
  logGroup,
  // Newer config props not covered elsewhere.
  snapStart: SnapStartConf.ON_PUBLISHED_VERSIONS,
  runtimeManagementMode: RuntimeManagementMode.AUTO,
  deadLetterQueue: dlq,
  tracing: Tracing.ACTIVE,
});

app.synth();

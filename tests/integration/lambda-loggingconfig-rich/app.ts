// CDK app for the cdk-real-drift Lambda LoggingConfig false-positive test.
// Lambda is the most commonly deployed CDK resource, and structured (JSON)
// logging with per-level controls + an explicit log group is a now-standard
// "production" config that the existing lambda fixtures do NOT exercise (none
// declare LoggingConfig). This emits AWS::Lambda::Function.LoggingConfig
// {LogFormat: JSON, ApplicationLogLevel, SystemLogLevel, LogGroup} — values AWS
// may normalize or pair with defaults. A freshly deployed + recorded function
// with NO out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  ApplicationLogLevel,
  Architecture,
  Code,
  Function as LambdaFunction,
  LoggingFormat,
  Runtime,
  SystemLogLevel,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaLoggingConfigRich");

const logGroup = new LogGroup(stack, "Logs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

new LambdaFunction(stack, "Handler", {
  runtime: Runtime.NODEJS_20_X,
  architecture: Architecture.ARM_64,
  handler: "index.handler",
  code: Code.fromInline("export const handler = async () => ({ ok: true });"),
  memorySize: 256,
  timeout: Duration.seconds(10),
  description: "cdkrd lambda-loggingconfig-rich test handler",
  // Structured JSON logging with explicit application/system log levels and a
  // customer-owned log group — the LoggingConfig the existing fixtures lack.
  loggingFormat: LoggingFormat.JSON,
  applicationLogLevelV2: ApplicationLogLevel.INFO,
  systemLogLevelV2: SystemLogLevel.WARN,
  logGroup,
  environment: {
    STAGE: "test",
  },
});

app.synth();

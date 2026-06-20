// CDK app for the cdk-real-drift EXPRESS Step Functions false-positive test.
// The existing `stepfunctions` fixture is a STANDARD state machine with no logging.
// An EXPRESS machine with a CloudWatch LoggingConfiguration and X-Ray tracing is a
// different, very common production shape: LoggingConfiguration nests a
// Destinations array of LogGroup ARN refs + a Level + IncludeExecutionData boolean,
// and TracingConfiguration is a single-key object that AWS may default-fold. A
// freshly deployed + recorded machine with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  DefinitionBody,
  LogLevel,
  Pass,
  StateMachine,
  StateMachineType,
  Succeed,
} from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSfnExpress");

const logGroup = new LogGroup(stack, "Logs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

const start = new Pass(stack, "Start", { comment: "a pass state" });
const done = new Succeed(stack, "Done");

const sm = new StateMachine(stack, "Machine", {
  stateMachineType: StateMachineType.EXPRESS,
  definitionBody: DefinitionBody.fromChainable(start.next(done)),
  tracingEnabled: true,
  logs: {
    destination: logGroup,
    level: LogLevel.ALL,
    includeExecutionData: true,
  },
});
Tags.of(sm).add("team", "platform");

app.synth();

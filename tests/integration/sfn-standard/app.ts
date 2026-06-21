// cdk-real-drift sfn-standard FP + detect integration test. A STANDARD (not express)
// Step Functions state machine with CloudWatch logging + X-Ray tracing — exercises
// LoggingConfiguration (nested) + TracingConfiguration defaults. The mutable
// TracingConfiguration.Enabled is the declared detect/revert subject.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { DefinitionBody, LogLevel, Pass, StateMachine, StateMachineType } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSfnStandard");
const lg = new LogGroup(stack, "Logs", { removalPolicy: RemovalPolicy.DESTROY });
new StateMachine(stack, "SM", {
  stateMachineName: "cdkrd-sfn-standard",
  stateMachineType: StateMachineType.STANDARD,
  definitionBody: DefinitionBody.fromChainable(new Pass(stack, "P")),
  tracingEnabled: true,
  logs: { destination: lg, level: LogLevel.ALL, includeExecutionData: true },
});
app.synth();

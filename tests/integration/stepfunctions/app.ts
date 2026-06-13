// CDK app for the cdk-real-drift Step Functions false-positive integration test
// (R88). Tricky declared property: DefinitionString — a (large) JSON string whose
// live form may differ in key order / whitespace (R75 JSON-string handling). The
// auto-created execution role also exercises policy canonicalization.
import { App, Stack, Tags } from "aws-cdk-lib";
import { DefinitionBody, Pass, StateMachine, Succeed } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSfn");

const start = new Pass(stack, "Start", { comment: "a pass state" });
const done = new Succeed(stack, "Done");

const sm = new StateMachine(stack, "Machine", {
  definitionBody: DefinitionBody.fromChainable(start.next(done)),
});
Tags.of(sm).add("team", "platform");

app.synth();

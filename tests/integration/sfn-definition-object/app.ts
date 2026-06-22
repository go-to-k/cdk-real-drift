// CDK app for the cdk-real-drift Step Functions Definition-as-object false-positive
// test. A StateMachine is most often declared with definitionBody -> DefinitionString
// (a JSON STRING), and every existing fixture exercises that string form. CDK /
// CloudFormation also accepts the `Definition` property: a JSON OBJECT inline in the
// template. AWS / Cloud Control, however, always returns the machine's definition as
// `DefinitionString` (a STRING) — there is no `Definition` (object) attribute on the
// live model. So when the template declares `Definition` (object) and the live read
// returns `DefinitionString` (string), the two carry DIFFERENT property names and no
// drift record pairs them: the declared `Definition` looks removed and/or the live
// `DefinitionString` looks undeclared — a shape-divergence false positive. A freshly
// deployed + recorded machine with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSfnDefinitionObject");

const role = new Role(stack, "SfnRole", {
  assumedBy: new ServicePrincipal("states.amazonaws.com"),
});

// Keep the linter from flagging the unused import while documenting that a real
// state machine role would carry an execution policy.
void PolicyStatement;

// Declare the definition as a JSON OBJECT via the `definition` prop (NOT
// definitionString). CfnStateMachine.definition is typed `object | IResolvable`, so the
// JS object literal is passed directly. The whole point is to land a `Definition`
// (object) in the template, distinct from the `DefinitionString` AWS returns live.
new CfnStateMachine(stack, "Machine", {
  roleArn: role.roleArn,
  stateMachineName: "cdkrd-fp-def-object",
  definition: {
    StartAt: "Pass1",
    States: {
      Pass1: { Type: "Pass", Result: { ok: true }, Next: "Pass2" },
      Pass2: { Type: "Pass", End: true },
    },
  },
});

app.synth();

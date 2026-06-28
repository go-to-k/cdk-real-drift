// CDK app for the cdk-real-drift Step Functions definition revert-gap test.
//
// AWS::StepFunctions::StateMachine.DefinitionString is CC-readable (a console /
// update-state-machine edit to the ASL is DETECTED), but the state-machine
// definition is updated through the dedicated UpdateStateMachine API. A Cloud
// Control UpdateResource patch of DefinitionString may not apply cleanly. This
// fixture verifies detect -> revert -> CLEAN -> live definition actually restored.
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSfnDefinitionRevert");

const role = new Role(stack, "Role", {
  assumedBy: new ServicePrincipal("states.amazonaws.com"),
});

new CfnStateMachine(stack, "Sm", {
  roleArn: role.roleArn,
  stateMachineType: "STANDARD",
  definitionString: JSON.stringify({
    Comment: "cdkrd sfn definition revert probe",
    StartAt: "Pass1",
    States: {
      Pass1: { Type: "Pass", Result: { v: 1 }, End: true },
    },
  }),
});

app.synth();

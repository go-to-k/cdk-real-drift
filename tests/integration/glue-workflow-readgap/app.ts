// CDK app for the cdk-real-drift glue-workflow-readgap integration test.
//
// AWS::Glue::Workflow is a CC read gap (NON_PROVISIONABLE — GetResource throws
// UnsupportedActionException), so the workflow was silently `skipped` and an out-of-band
// change to its Description / DefaultRunProperties / MaxConcurrentRuns was INVISIBLE (a
// false negative on the ETL-orchestration resource). The new SDK_OVERRIDES reader (Glue
// GetWorkflow) closes it; MaxConcurrentRuns / Description are declared MUTABLE props a
// console edit can change, so it doubles as the false-NEGATIVE half. Cheap: a workflow is a
// standalone account-level resource — no role, no jobs, no NAT.
import { App, Stack } from "aws-cdk-lib";
import { CfnWorkflow } from "aws-cdk-lib/aws-glue";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlueWorkflowReadgap");

new CfnWorkflow(stack, "Workflow", {
  name: "cdkrd-workflow",
  description: "cdkrd glue-workflow read-gap probe",
  maxConcurrentRuns: 3,
  defaultRunProperties: {
    env: "test",
    team: "data",
  },
});

app.synth();

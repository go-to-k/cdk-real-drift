// CDK app for the cdk-real-drift ssmmw-hunt false-positive integration test.
// First live exercise of AWS::SSM::MaintenanceWindowTarget and
// AWS::SSM::MaintenanceWindowTask — both have CC identifier adapters but zero
// corpus cases and zero fixtures, so their composite-identifier read paths have
// never run against real AWS. The parent MaintenanceWindow has a corpus case
// but no live fixture. A clean first `check` (before `record`) must show ZERO
// potential drift.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnMaintenanceWindow,
  CfnMaintenanceWindowTarget,
  CfnMaintenanceWindowTask,
} from "aws-cdk-lib/aws-ssm";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntSsmMw0713");

const window = new CfnMaintenanceWindow(stack, "Window", {
  name: "cdkrd-hunt-mw-0713",
  allowUnassociatedTargets: false,
  cutoff: 1,
  duration: 2,
  schedule: "rate(7 days)",
});

const target = new CfnMaintenanceWindowTarget(stack, "Target", {
  windowId: window.ref,
  resourceType: "INSTANCE",
  targets: [{ key: "tag:cdkrd", values: ["hunt"] }],
});

new CfnMaintenanceWindowTask(stack, "Task", {
  windowId: window.ref,
  taskType: "RUN_COMMAND",
  taskArn: "AWS-RunShellScript",
  priority: 1,
  targets: [{ key: "WindowTargetIds", values: [target.ref] }],
  maxConcurrency: "1",
  maxErrors: "1",
});

app.synth();

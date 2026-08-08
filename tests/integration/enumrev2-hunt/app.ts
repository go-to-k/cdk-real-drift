// CDK app for the cdk-real-drift enumrev2-hunt integration test (2026-08-09 hunt).
// Completes the added->revert(DELETE) proof for the #1720/#1721 child-enumerator
// family: the 2026-08-03 enum-added2-hunt proved the delete-kind plan path live for
// MaintenanceWindowTarget / CodeDeploy DeploymentGroup / EB ApplicationVersion /
// AppAutoScaling ScalingPolicy / GuardDuty Filter, but NOT for the two remaining
// child types with distinct CC delete handlers:
//   - AWS::SSM::MaintenanceWindowTask       (OOB register-task-with-maintenance-window)
//   - AWS::ElasticBeanstalk::ConfigurationTemplate (OOB create-configuration-template)
// Each parent carries one DECLARED child of the same type so the "declared children
// are NOT flagged" half re-runs too. A first check (pre-record) must be CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApplication as CfnEbApplication,
  CfnConfigurationTemplate,
} from "aws-cdk-lib/aws-elasticbeanstalk";
import {
  CfnMaintenanceWindow,
  CfnMaintenanceWindowTarget,
  CfnMaintenanceWindowTask,
} from "aws-cdk-lib/aws-ssm";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");

// Solution stack names rot as platforms retire; verify.sh resolves the current
// Docker/AL2023 one at run time and threads it in via `-c ss=...`.
const solutionStack =
  (app.node.tryGetContext("ss") as string | undefined) ??
  "64bit Amazon Linux 2023 v4.13.3 running Docker";

const stack = new Stack(app, "CdkrdHuntEnumRev0809");

// ── SSM MaintenanceWindow + declared Target + declared Task ────────────────
const window = new CfnMaintenanceWindow(stack, "Window", {
  name: "cdkrd-hunt-mw-0809b",
  allowUnassociatedTargets: false,
  cutoff: 1,
  duration: 2,
  schedule: "rate(7 days)",
});
const target = new CfnMaintenanceWindowTarget(stack, "Target", {
  windowId: window.ref,
  resourceType: "INSTANCE",
  targets: [{ key: "tag:cdkrd", values: ["hunt-0809b"] }],
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

// ── Elastic Beanstalk Application + declared ConfigurationTemplate ─────────
const ebApp = new CfnEbApplication(stack, "EbApp", {
  applicationName: "cdkrd-hunt-eb-0809b",
});
const ebTemplate = new CfnConfigurationTemplate(stack, "EbTemplate", {
  applicationName: ebApp.applicationName!,
  solutionStackName: solutionStack,
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "SingleInstance",
    },
  ],
});
ebTemplate.addDependency(ebApp);

app.synth();

// Revert-convergence probe batch 9 (real AWS): two recently added
// KNOWN_DEFAULT(_PATHS) folds whose update APIs are proven-SELECTIVE for a
// SIBLING property (which needed an RSDP entry) but were never probed
// themselves — the bare-`remove` silent-no-op class (#1571 family):
// - Backup RestoreTestingPlan RecoveryPointSelection.SelectionWindowDays (30):
//   StartWindowHours / ScheduleExpressionTimezone on the SAME
//   UpdateRestoreTestingPlan call no-oped (#1640); this nested sibling rides
//   the same call and was left unprobed.
// - RUM AppMonitor AppMonitorConfiguration (whole-object pin): sibling
//   CustomEvents on the SAME UpdateAppMonitor call no-oped (#1630).
// Both are left UNDECLARED here; verify.sh mutates them out of band, asserts
// detection, reverts, and asserts the LIVE value returned to the default.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnRestoreTestingPlan } from "aws-cdk-lib/aws-backup";
import { CfnAppMonitor } from "aws-cdk-lib/aws-rum";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722Rc6");

new CfnRestoreTestingPlan(stack, "HuntRtp", {
  restoreTestingPlanName: "cdkrd_hunt0722_rtp",
  scheduleExpression: "cron(0 5 ? * MON *)",
  recoveryPointSelection: {
    algorithm: "LATEST_WITHIN_WINDOW",
    includeVaults: ["*"],
    recoveryPointTypes: ["SNAPSHOT"],
  },
});

new CfnAppMonitor(stack, "HuntRumMonitor", {
  name: "cdkrd-hunt0722-rum",
  domain: "cdkrd-hunt.example.com",
});

app.synth();

// CDK app for the cdk-real-drift AWS Backup false-positive test. A backup vault +
// plan is the standard compliance/DR pattern. It exercises a BackupVault and a
// BackupPlan whose nested BackupRules carry schedule expressions and a Lifecycle
// (MoveToColdStorageAfterDays / DeleteAfterDays) — nested numeric/string config
// AWS default-fills and re-serializes server-side. A freshly deployed + recorded
// vault + plan with NO out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { BackupPlan, BackupPlanRule, BackupVault } from "aws-cdk-lib/aws-backup";
import { Schedule } from "aws-cdk-lib/aws-events";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegBackupRich");

const vault = new BackupVault(stack, "Vault", {
  backupVaultName: "cdkrd-backup-rich",
  removalPolicy: RemovalPolicy.DESTROY,
});

const plan = new BackupPlan(stack, "Plan", {
  backupPlanName: "cdkrd-backup-rich",
  backupVault: vault,
});
plan.addRule(
  new BackupPlanRule({
    ruleName: "Daily",
    scheduleExpression: Schedule.cron({ hour: "5", minute: "0" }),
    startWindow: Duration.hours(1),
    completionWindow: Duration.hours(2),
    moveToColdStorageAfter: Duration.days(30),
    deleteAfter: Duration.days(120),
  })
);

app.synth();

// CDK app probing the RDS revert-gap hypothesis: RDS modifications normally need
// ApplyImmediately=true to take effect now (otherwise they queue in
// pending-modified-values until the maintenance window). AWS::RDS::DBInstance is
// CC-readable, so a BackupRetentionPeriod change is DETECTED — the question is
// whether a Cloud Control UpdateResource patch actually applies it (or silently
// queues it so `check` still drifts after `revert`). BackupRetentionPeriod is a
// common, mutable, no-downtime knob. Uses the account's default VPC + default DB
// subnet group; manageMasterUserPassword avoids a plaintext secret in the template.
import { App, Stack } from "aws-cdk-lib";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRdsBackupRetentionRevert");

new CfnDBInstance(stack, "Db", {
  engine: "mysql",
  engineVersion: "8.0",
  dbInstanceClass: "db.t3.micro",
  allocatedStorage: "20",
  masterUsername: "cdkrdadmin",
  manageMasterUserPassword: true,
  backupRetentionPeriod: 7,
  deletionProtection: false,
  publiclyAccessible: false,
});

app.synth();

// #1582 regression fixture: an AWS::RDS::DBInstance DECLARES a write-only property
// (MasterUserPassword), which surfaces as a write-only readGap. That readGap used to mark the
// resource NOT `complete`, silently disabling "appeared since record" detection — so an
// out-of-band change to an UNDECLARED property that was at its AWS default when recorded (here
// CopyTagsToSnapshot false→true) surfaced only as [Not Recorded] and `check --fail` exited 0
// (a false negative). verify-detect.sh enables CopyTagsToSnapshot out of band and asserts
// `check` now DETECTS it. The undeclared CopyTagsToSnapshot / MonitoringInterval / MultiAZ are
// left UNDECLARED (they fold atDefault on a first check) so they are appeared-since-record
// candidates. A monitoring role is kept for reuse. (The ModifyDBInstance revert-no-op twins of
// #1541 are a SEPARATE follow-up — detection had to be fixed first.)
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";
import { CfnRole } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntRdsRevertTwins0713");

// Enhanced-monitoring role (used only when MonitoringInterval is enabled out of band).
const monRole = new CfnRole(stack, "MonRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "monitoring.rds.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  },
  managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"],
});

// Barest provisioned instance: only the required props. Every twin below is UNDECLARED and
// folds to its KNOWN_DEFAULTS default on a first check.
new CfnDBInstance(stack, "Db", {
  engine: "mariadb",
  dbInstanceClass: "db.t3.micro",
  allocatedStorage: "20",
  masterUsername: "cdkrdadmin",
  masterUserPassword: "CdkrdHunt0713Pass",
  publiclyAccessible: false,
  deletionProtection: false,
});

// Surface the monitoring role arn for verify-detect.sh (via a stack output is overkill; the
// script resolves it from the stack resources instead). Keep a reference so it is not pruned.
void monRole;

app.synth();

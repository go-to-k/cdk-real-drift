// CDK app for the cdk-real-drift AWS Backup *Selection* false-positive test. A
// BackupSelection's tag-based membership is an insertionOrder:false SET that AWS
// MAY echo in its own canonical order — the existing backup-rich fixture only
// covered the Vault + Plan, never a Selection. We probe BOTH membership shapes,
// each declared in DELIBERATELY non-sorted order, on separate selections:
//
//   BackupSelection.ListOfTags            — object set {ConditionType,ConditionKey,ConditionValue}
//   BackupSelection.Conditions.StringEquals — object set {ConditionKey,ConditionValue}
//
// Neither element key (ConditionKey) is one of cdkrd's IDENTITY_FIELDS
// (Key/Id/AttributeName/IndexName/Name), so a keyed canonicalizer cannot align a
// reorder — if AWS sorts either set (e.g. by ConditionKey), a positional compare
// false-flags the identical membership set as declared drift on every check. AWS
// Backup vault/plan/selection/role are all free (no backups run). A freshly
// deployed + recorded selection with NO out-of-band change MUST be CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { BackupPlan, BackupPlanRule, BackupVault } from "aws-cdk-lib/aws-backup";
import { CfnBackupSelection } from "aws-cdk-lib/aws-backup";
import { Schedule } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal, ManagedPolicy } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegBackupSelection");

const vault = new BackupVault(stack, "Vault", {
  backupVaultName: "cdkrd-backup-selection",
  removalPolicy: RemovalPolicy.DESTROY,
});
const plan = new BackupPlan(stack, "Plan", {
  backupPlanName: "cdkrd-backup-selection",
  backupVault: vault,
});
plan.addRule(
  new BackupPlanRule({
    ruleName: "Daily",
    scheduleExpression: Schedule.cron({ hour: "5", minute: "0" }),
    startWindow: Duration.hours(1),
    completionWindow: Duration.hours(2),
    deleteAfter: Duration.days(35),
  })
);

const role = new Role(stack, "BackupRole", {
  assumedBy: new ServicePrincipal("backup.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSBackupServiceRolePolicyForBackup"),
  ],
});

// Selection A — legacy ListOfTags, declared non-sorted by ConditionKey (zeta before alpha).
new CfnBackupSelection(stack, "SelByTags", {
  backupPlanId: plan.backupPlanId,
  backupSelection: {
    selectionName: "cdkrd-by-tags",
    iamRoleArn: role.roleArn,
    listOfTags: [
      { conditionType: "STRINGEQUALS", conditionKey: "zeta", conditionValue: "1" },
      { conditionType: "STRINGEQUALS", conditionKey: "alpha", conditionValue: "2" },
      { conditionType: "STRINGEQUALS", conditionKey: "mike", conditionValue: "3" },
    ],
  },
});

// Selection B — newer Conditions.StringEquals, declared non-sorted by ConditionKey.
new CfnBackupSelection(stack, "SelByConditions", {
  backupPlanId: plan.backupPlanId,
  backupSelection: {
    selectionName: "cdkrd-by-conditions",
    iamRoleArn: role.roleArn,
    // Conditions is a REFINEMENT — AWS rejects a selection that has only Conditions,
    // so it must accompany a non-empty Resources (or ListOfTags). Resources is a
    // scalar ARN-pattern set (ARN-shaped → canonicalizeIdArraysDeep would sort it),
    // declared here so the selection is valid; the probe target is Conditions below.
    resources: ["arn:aws:ec2:*:*:instance/*"],
    // `conditions` is a free-form L1 property (not auto-mapped to PascalCase like
    // listOfTags), so the CFn-shaped keys are written directly.
    conditions: {
      StringEquals: [
        { ConditionKey: "aws:ResourceTag/zebra", ConditionValue: "x" },
        { ConditionKey: "aws:ResourceTag/apple", ConditionValue: "y" },
        { ConditionKey: "aws:ResourceTag/mango", ConditionValue: "z" },
      ],
    },
  },
});

app.synth();

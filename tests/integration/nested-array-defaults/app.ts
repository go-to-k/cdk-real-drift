// CDK app for the cdk-real-drift "nested array materialized-default" integration test.
// Two resources whose array elements are keyed by a NON-standard field (not Key/Id/Name/…),
// so collectNestedUndeclared could not descend them before NESTED_ARRAY_IDENTITY — a silent
// FN. AWS materializes DEFAULTS into each live element (folded via KNOWN_DEFAULT_PATHS), so a
// clean stack stays clean, but an out-of-band change to a rule setting surfaces:
//   - AWS::Backup::BackupPlan  BackupPlanRule (keyed by RuleName) — compliance
//   - AWS::Route53Resolver::FirewallRuleGroup FirewallRules (keyed by Priority) — security
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { BackupPlan, BackupPlanRule, BackupVault } from "aws-cdk-lib/aws-backup";
import { Schedule } from "aws-cdk-lib/aws-events";
import { CfnFirewallDomainList, CfnFirewallRuleGroup } from "aws-cdk-lib/aws-route53resolver";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegNestedDefaults");

const vault = new BackupVault(stack, "Vault", { removalPolicy: RemovalPolicy.DESTROY });
new BackupPlan(stack, "Plan", {
  backupVault: vault,
  backupPlanRules: [
    new BackupPlanRule({ backupVault: vault, ruleName: "DailyRule", scheduleExpression: Schedule.cron({ hour: "3", minute: "0" }) }),
  ],
});

const dl = new CfnFirewallDomainList(stack, "DL", { domains: ["example.com."] });
dl.applyRemovalPolicy(RemovalPolicy.DESTROY);
const rg = new CfnFirewallRuleGroup(stack, "RG", {
  firewallRules: [{ firewallDomainListId: dl.attrId, priority: 100, action: "BLOCK", blockResponse: "NODATA" }],
});
rg.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

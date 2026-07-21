// Post-update echo probe (second deploy) over the post-2026-07-14 fold types that
// never had a rev=2 update probe: UDP/TCP_UDP TargetGroups (#1664), DLM
// LifecyclePolicy (#1663..#1669), Lambda Alias provisioned concurrency
// (lambda-pc-hunt), Route 53 latency/failover records + HealthCheck
// (route53-policy-hunt), and Budgets Budget fixed + auto-adjusting (#1678/#1679 —
// a CFn UPDATE drives UpdateBudget, a fresh post-write echo surface for the new
// writer/reader pair). Deploy -> first check CLEAN -> record -> redeploy -c rev=2
// (real per-resource updates, not tag-only) -> re-check MUST stay CLEAN.
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnLifecyclePolicy } from "aws-cdk-lib/aws-dlm";
import { CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = Number(app.node.tryGetContext("rev") ?? 1);
if (rev > 1) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0721Echo4");

// ---- UDP-family TargetGroups (#1664 rows) — a real update via the health-check
// interval, which is mutable on NLB-family groups.
const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.71.0.0/16" });
new CfnTargetGroup(s, "TgUdp", {
  protocol: "UDP",
  port: 53,
  vpcId: vpc.ref,
  targetType: "ip",
  healthCheckProtocol: "TCP",
  healthCheckIntervalSeconds: rev > 1 ? 35 : 30,
});
new CfnTargetGroup(s, "TgTcpUdp", {
  protocol: "TCP_UDP",
  port: 53,
  vpcId: vpc.ref,
  targetType: "ip",
  healthCheckProtocol: "TCP",
  healthCheckIntervalSeconds: rev > 1 ? 35 : 30,
});

// ---- DLM custom policy (#1663..#1669 fold family) — Description update.
const dlmRole = new Role(s, "DlmRole", {
  assumedBy: new ServicePrincipal("dlm.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName(
      "service-role/AWSDataLifecycleManagerServiceRole",
    ),
  ],
});
new CfnLifecyclePolicy(s, "DlmPolicy", {
  description: `cdkrd hunt 0721 echo probe rev${rev}`,
  executionRoleArn: dlmRole.roleArn,
  state: "ENABLED",
  policyDetails: {
    policyType: "EBS_SNAPSHOT_MANAGEMENT",
    resourceTypes: ["VOLUME"],
    targetTags: [{ key: "cdkrd-hunt", value: "0721" }],
    schedules: [
      {
        name: "cdkrd-hunt-daily",
        createRule: { interval: 12, intervalUnit: "HOURS" },
        retainRule: { count: 1 },
      },
    ],
  },
});

// ---- Lambda Alias with provisioned concurrency (lambda-pc-hunt types) — the
// function Description change mints a new Version, repointing the alias and
// re-provisioning PC: the full alias-update path.
const fn = new lambda.Function(s, "Fn", {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: lambda.Code.fromInline('exports.handler = async () => "ok";'),
  memorySize: 128,
  timeout: Duration.seconds(3),
  description: `cdkrd hunt 0721 rev${rev}`,
});
new lambda.Alias(s, "LiveAlias", {
  aliasName: "live",
  version: fn.currentVersion,
  provisionedConcurrentExecutions: 1,
});

// ---- Route 53 latency + failover records (route53-policy-hunt types) — TTL and
// failure-threshold updates. Placeholder domain (example.com/.test are AWS-reserved).
const zone = new route53.PublicHostedZone(s, "Zone", {
  zoneName: "cdkrd-hunt0721-e4x.com",
});
const ttl = rev > 1 ? "61" : "60";
new route53.CfnRecordSet(s, "LatUse1", {
  hostedZoneId: zone.hostedZoneId,
  name: "lat.cdkrd-hunt0721-e4x.com.",
  type: "A",
  ttl,
  resourceRecords: ["192.0.2.1"],
  setIdentifier: "use1",
  region: "us-east-1",
});
new route53.CfnRecordSet(s, "LatEuw1", {
  hostedZoneId: zone.hostedZoneId,
  name: "lat.cdkrd-hunt0721-e4x.com.",
  type: "A",
  ttl,
  resourceRecords: ["192.0.2.2"],
  setIdentifier: "euw1",
  region: "eu-west-1",
});
// Health-check target must be a resolvable FQDN (Route 53 rejects TEST-NET IPs).
const health = new route53.CfnHealthCheck(s, "PrimaryHealth", {
  healthCheckConfig: {
    type: "HTTP",
    fullyQualifiedDomainName: "example.com",
    port: 80,
    resourcePath: "/",
    requestInterval: 30,
    failureThreshold: rev > 1 ? 4 : 3,
  },
});
new route53.CfnRecordSet(s, "FailPrimary", {
  hostedZoneId: zone.hostedZoneId,
  name: "fo.cdkrd-hunt0721-e4x.com.",
  type: "A",
  ttl,
  resourceRecords: ["192.0.2.20"],
  setIdentifier: "primary",
  failover: "PRIMARY",
  healthCheckId: health.attrHealthCheckId,
});
new route53.CfnRecordSet(s, "FailSecondary", {
  hostedZoneId: zone.hostedZoneId,
  name: "fo.cdkrd-hunt0721-e4x.com.",
  type: "A",
  ttl,
  resourceRecords: ["192.0.2.21"],
  setIdentifier: "secondary",
  failover: "SECONDARY",
});

// ---- Budgets: fixed-limit (amount update) + auto-adjusting (lookback update) —
// each CFn update drives UpdateBudget, probing the post-write echo of the new
// #1678 writer / #1679 reader surface.
new CfnBudget(s, "BudgetFixed", {
  budget: {
    budgetName: "cdkrd-hunt0721-fixed",
    budgetType: "COST",
    timeUnit: "MONTHLY",
    budgetLimit: { amount: rev > 1 ? 6 : 5, unit: "USD" },
  },
});
new CfnBudget(s, "BudgetAad", {
  budget: {
    budgetName: "cdkrd-hunt0721-aad",
    budgetType: "COST",
    timeUnit: "MONTHLY",
    autoAdjustData: {
      autoAdjustType: "HISTORICAL",
      historicalOptions: { budgetAdjustmentPeriod: rev > 1 ? 7 : 6 },
    },
  },
});

app.synth();

// 2026-08-10 hunt: SDK-writer live-proof pack. The Round-0 audit found the READ
// side almost fully live-exercised but ~10 SDK writers / prop writers / deleters
// with a corpus-proven reader and a revert path that has NEVER run against real
// AWS. One nearly-free stack; each resource gets an out-of-band mutation ->
// detect -> revert -> live-value assert in verify-detect.sh:
//  - ELBv2 TargetGroup attribute bag (modify-target-group-attributes writer)
//  - ElastiCache ParameterGroup (declared param drift -> writer)
//  - DAX ParameterGroup (undeclared param drift -> writer)
//  - Budgets Budget (writeBudget, #1676 — never live-run)
//  - CloudWatch CompositeAlarm ActionsEnabled (SDK_PROP_WRITERS via
//    Enable/DisableAlarmActions — the batch-5 no-op fix, never live-run)
//  - Cognito IdentityPool CognitoEvents (cognito-sync prop writer)
//  - SES ConfigurationSetEventDestination (SESv2 update writer)
//  - ServiceDiscovery Service (UpdateService writer — namespace writer is proven,
//    the Service one is not)
//  - KMS Grant (synthetic added-tier: out-of-band create-grant -> revert must
//    RevokeGrant — deleter never live-run)
//  - Logs LogGroup BearerTokenAuthenticationEnabled (dedicated-API prop writer)
import { App, Fn, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnAlarm, CfnCompositeAlarm } from "aws-cdk-lib/aws-cloudwatch";
import { CfnIdentityPool } from "aws-cdk-lib/aws-cognito";
import { CfnParameterGroup as CfnDaxParameterGroup } from "aws-cdk-lib/aws-dax";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnParameterGroup as CfnEcParameterGroup } from "aws-cdk-lib/aws-elasticache";
import { CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnKey } from "aws-cdk-lib/aws-kms";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnPrivateDnsNamespace, CfnService } from "aws-cdk-lib/aws-servicediscovery";
import { CfnConfigurationSet, CfnConfigurationSetEventDestination } from "aws-cdk-lib/aws-ses";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0810Wrt");

// --- ELBv2 TargetGroup (standalone, no LB needed for its attribute bag) ---
const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.0.0.0/24" });
new CfnSubnet(stack, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.0.0/25",
  availabilityZone: Fn.select(0, Fn.getAzs()),
});
new CfnTargetGroup(stack, "Tg", {
  name: "cdkrd-0810w-tg",
  protocol: "TCP",
  port: 80,
  vpcId: vpc.ref,
  targetType: "instance",
});

// --- ElastiCache ParameterGroup (declared params -> declared-drift revert) ---
new CfnEcParameterGroup(stack, "EcPg", {
  cacheParameterGroupFamily: "redis7",
  description: "cdkrd 0810 writer hunt",
  properties: {
    "maxmemory-policy": "allkeys-lru",
  },
});

// --- DAX ParameterGroup (barest: params undeclared -> undeclared-drift revert) ---
new CfnDaxParameterGroup(stack, "DaxPg", {
  parameterGroupName: "cdkrd-0810w-daxpg",
  description: "cdkrd 0810 writer hunt",
});

// --- Budgets Budget (writeBudget) ---
new CfnBudget(stack, "Budget", {
  budget: {
    budgetName: "cdkrd-0810w-budget",
    budgetType: "COST",
    timeUnit: "MONTHLY",
    budgetLimit: { amount: 100, unit: "USD" },
  },
});

// --- CloudWatch metric alarm + CompositeAlarm (ActionsEnabled prop writer) ---
const cpu = new CfnAlarm(stack, "CpuAlarm", {
  alarmName: "cdkrd-0810w-cpu",
  namespace: "AWS/EC2",
  metricName: "CPUUtilization",
  statistic: "Average",
  period: 300,
  evaluationPeriods: 2,
  threshold: 80,
  comparisonOperator: "GreaterThanThreshold",
});
const composite = new CfnCompositeAlarm(stack, "Composite", {
  alarmName: "cdkrd-0810w-composite",
  alarmRule: `ALARM("${cpu.alarmName}")`,
});
// the composite validates its member alarms EXIST at create — force the ordering
composite.addDependency(cpu);

// --- Cognito IdentityPool + a minimal Lambda for the CognitoEvents SyncTrigger ---
const lambdaRole = new CfnRole(stack, "FnRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  },
});
const fn = new CfnFunction(stack, "Fn", {
  functionName: "cdkrd-0810w-fn",
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: lambdaRole.attrArn,
  code: { zipFile: "exports.handler = async () => ({});" },
});
new CfnIdentityPool(stack, "IdPool", {
  identityPoolName: "cdkrd0810wpool",
  allowUnauthenticatedIdentities: false,
});

// --- SES ConfigurationSet + EventDestination (SESv2 update writer) ---
const cs = new CfnConfigurationSet(stack, "SesCs", { name: "cdkrd-0810w-cs" });
new CfnConfigurationSetEventDestination(stack, "SesDest", {
  configurationSetName: cs.ref,
  eventDestination: {
    name: "cdkrd-0810w-dest",
    enabled: true,
    matchingEventTypes: ["SEND", "BOUNCE", "COMPLAINT"],
    cloudWatchDestination: {
      dimensionConfigurations: [
        {
          dimensionName: "ses-source",
          dimensionValueSource: "messageTag",
          defaultDimensionValue: "none",
        },
      ],
    },
  },
});

// --- Cloud Map private-DNS namespace + Service (UpdateService writer) ---
// (a Service in an HTTP namespace is API-ONLY and CANNOT be updated —
// "Service in API-only namespace cannot be updated", live 2026-08-10 — so the
// UpdateService writer is provable only on a DNS-namespace service)
const ns = new CfnPrivateDnsNamespace(stack, "Ns", {
  name: "cdkrd0810w.local",
  vpc: vpc.ref,
  description: "cdkrd 0810 writer hunt ns",
});
new CfnService(stack, "Svc", {
  name: "cdkrd-0810w-svc",
  namespaceId: ns.attrId,
  description: "cdkrd 0810 writer hunt svc",
  dnsConfig: {
    dnsRecords: [{ type: "A", ttl: 60 }],
    routingPolicy: "MULTIVALUE",
  },
});

// --- KMS key (out-of-band create-grant -> synthetic added AWS::KMS::Grant) ---
const key = new CfnKey(stack, "Key", {
  description: "cdkrd 0810 writer hunt",
  pendingWindowInDays: 7,
});
key.applyRemovalPolicy(RemovalPolicy.DESTROY);

// --- LogGroup (BearerTokenAuthenticationEnabled dedicated-API prop writer) ---
const lg = new CfnLogGroup(stack, "Lg", { logGroupName: "cdkrd-0810w-lg" });
lg.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

// Corpus-harvest fixture wave 5 (R77): more cheap, fast-create families the
// corpus has never seen live, chosen for BREADTH over the long tail of CFn
// types real apps use — AppConfig (app/env/profile/strategy), EventBridge
// Connection+ApiDestination+Archive, Glue Job+Trigger, Lambda LayerVersion+
// Alias, IAM InstanceProfile, Route53 HealthCheck, a CloudWatch CompositeAlarm,
// an EXPRESS StateMachine, and SSM Parameter variants. Everything is cheap and
// fast to create/delete; no VPC, no NAT, no slow resources (no RDS/ES/CF).
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnConfigurationProfile,
  CfnDeploymentStrategy,
  CfnEnvironment,
} from "aws-cdk-lib/aws-appconfig";
import { Alarm, AlarmRule, ComparisonOperator, CompositeAlarm, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { CfnApiDestination, CfnArchive, CfnConnection } from "aws-cdk-lib/aws-events";
import { CfnJob, CfnTrigger } from "aws-cdk-lib/aws-glue";
import { InstanceProfile, ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Code, Function as Fn, Runtime } from "aws-cdk-lib/aws-lambda";
import { CfnHealthCheck } from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { DefinitionBody, StateMachine, StateMachineType, Pass } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkrdIntegHarvest5");

// ---- AppConfig (4 cheap types, deeply enum/number-typed)
const cfgApp = new CfnApplication(stack, "Cfg", { name: "cdkrd-harvest5" });
new CfnEnvironment(stack, "CfgEnv", {
  applicationId: cfgApp.ref,
  name: "prod",
  description: "cdkrd harvest5 env",
});
new CfnConfigurationProfile(stack, "CfgProfile", {
  applicationId: cfgApp.ref,
  name: "flags",
  locationUri: "hosted",
  type: "AWS.AppConfig.FeatureFlags",
});
new CfnDeploymentStrategy(stack, "CfgStrategy", {
  name: "cdkrd-harvest5-canary",
  deploymentDurationInMinutes: 10,
  growthFactor: 25,
  finalBakeTimeInMinutes: 5,
  growthType: "LINEAR",
  replicateTo: "NONE",
});

// ---- EventBridge Connection + ApiDestination + Archive
const conn = new CfnConnection(stack, "Conn", {
  authorizationType: "API_KEY",
  authParameters: {
    apiKeyAuthParameters: { apiKeyName: "x-api-key", apiKeyValue: "cdkrd-harvest5-key" },
  },
});
new CfnApiDestination(stack, "ApiDest", {
  connectionArn: conn.attrArn,
  httpMethod: "POST",
  invocationEndpoint: "https://example.com/webhook",
  invocationRateLimitPerSecond: 10,
});
new CfnArchive(stack, "Archive", {
  sourceArn: `arn:aws:events:${stack.region}:${stack.account}:event-bus/default`,
  retentionDays: 1,
  description: "cdkrd harvest5 archive",
});

// ---- Glue Job + Trigger (no Crawler: needs a data store)
const glueRole = new Role(stack, "GlueRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole")],
});
const job = new CfnJob(stack, "GlueJob", {
  name: "cdkrd-harvest5",
  role: glueRole.roleArn,
  glueVersion: "4.0",
  command: { name: "pythonshell", pythonVersion: "3.9", scriptLocation: "s3://aws-glue-scripts/noop.py" },
  maxCapacity: 0.0625,
});
new CfnTrigger(stack, "GlueTrigger", {
  type: "ON_DEMAND",
  actions: [{ jobName: job.ref }],
});

// ---- Lambda Function + Version + Alias
const fn = new Fn(stack, "AliasedFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => 'ok';"),
});
fn.addAlias("live", { description: "cdkrd harvest5 alias" });

// ---- IAM InstanceProfile
const ec2Role = new Role(stack, "Ec2Role", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
});
new InstanceProfile(stack, "Profile", { role: ec2Role });

// ---- Route53 HealthCheck (cheap; pings a public host)
new CfnHealthCheck(stack, "Health", {
  healthCheckConfig: {
    type: "HTTPS",
    fullyQualifiedDomainName: "example.com",
    port: 443,
    requestInterval: 30,
    failureThreshold: 3,
  },
});

// ---- CloudWatch CompositeAlarm over two child alarms
const mkAlarm = (id: string, ns: string) =>
  new Alarm(stack, id, {
    metric: new Metric({ namespace: ns, metricName: "Errors", period: Duration.minutes(5) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  });
const a1 = mkAlarm("AlarmA", "cdkrd/harvest5/a");
const a2 = mkAlarm("AlarmB", "cdkrd/harvest5/b");
new CompositeAlarm(stack, "Composite", {
  alarmRule: AlarmRule.anyOf(a1, a2),
});

// ---- EXPRESS StateMachine
new StateMachine(stack, "Express", {
  stateMachineType: StateMachineType.EXPRESS,
  definitionBody: DefinitionBody.fromChainable(new Pass(stack, "Noop")),
  removalPolicy: RemovalPolicy.DESTROY,
});

// ---- SSM Parameter (String + StringList)
new StringParameter(stack, "Param", {
  parameterName: "/cdkrd/harvest5/config",
  stringValue: "enabled",
  description: "cdkrd harvest5 parameter",
});

app.synth();

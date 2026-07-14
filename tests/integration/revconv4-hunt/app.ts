// Revert-convergence probe batch 5 (real AWS): ten cheap common types whose
// folded MUTABLE default has never been convergence-proven — does the CC
// handler reconcile a bare `remove` back to the default, or silently no-op
// (the #1571 class)? The API shape is not a predictor; only the live test
// answers, per-property. Candidates mined offline from KNOWN_DEFAULTS minus
// REVERT_SET_DEFAULT_PATHS coverage (none routes through an SDK writer):
// - ECS Cluster ClusterSettings (containerInsights disabled)
// - CloudWatch Alarm TreatMissingData ('missing')
// - CloudWatch CompositeAlarm ActionsEnabled (true)
// - CodeBuild Project TimeoutInMinutes (60) / QueuedTimeoutInMinutes (480)
// - AppSync GraphQLApi IntrospectionConfig ('ENABLED')
// - ApiGateway RestApi ApiKeySourceType ('HEADER')
// - MediaConvert Queue Status ('ACTIVE')
// - Scheduler Schedule ScheduleExpressionTimezone ('UTC')
// - Glue Crawler SchemaChangePolicy (UPDATE_IN_DATABASE/DEPRECATE_IN_DATABASE)
// - Pipes Pipe DesiredState ('RUNNING')
// The barest ECS Cluster / AppSync API / Glue Crawler / Pipe here also double
// as first-run FP probes.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnRestApi } from "aws-cdk-lib/aws-apigateway";
import { CfnGraphQLApi } from "aws-cdk-lib/aws-appsync";
import { CfnAlarm, CfnCompositeAlarm } from "aws-cdk-lib/aws-cloudwatch";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { CfnCluster } from "aws-cdk-lib/aws-ecs";
import { CfnCrawler, CfnDatabase } from "aws-cdk-lib/aws-glue";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnQueue as CfnMcQueue } from "aws-cdk-lib/aws-mediaconvert";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714RevConv4");

new CfnCluster(stack, "Conv4EcsCluster", {});

const alarm = new CfnAlarm(stack, "Conv4Alarm", {
  alarmName: "cdkrd-hunt0714-conv4-alarm",
  namespace: "cdkrd/hunt",
  metricName: "Conv4Metric",
  statistic: "Sum",
  period: 300,
  evaluationPeriods: 1,
  threshold: 1,
  comparisonOperator: "GreaterThanThreshold",
});

new CfnCompositeAlarm(stack, "Conv4Composite", {
  alarmName: "cdkrd-hunt0714-conv4-composite",
  alarmRule: `ALARM("${alarm.alarmName}")`,
}).addDependency(alarm);

const cbRole = new Role(stack, "Conv4CbRole", {
  assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
});
new CfnProject(stack, "Conv4CbProject", {
  name: "cdkrd-hunt0714-conv4-cb",
  serviceRole: cbRole.roleArn,
  source: { type: "NO_SOURCE", buildSpec: '{"version":"0.2","phases":{}}' },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    computeType: "BUILD_GENERAL1_SMALL",
    image: "aws/codebuild/standard:7.0",
  },
});

new CfnGraphQLApi(stack, "Conv4AppSync", {
  name: "cdkrd-hunt0714-conv4-appsync",
  authenticationType: "API_KEY",
});

new CfnRestApi(stack, "Conv4RestApi", { name: "cdkrd-hunt0714-conv4-rest" });

new CfnMcQueue(stack, "Conv4McQueue", { name: "cdkrd-hunt0714-conv4-mcq" });

// Scheduler: barest schedule targeting an SQS queue (never fires anything useful).
const schedQueue = new CfnQueue(stack, "Conv4SchedQueue", {});
const schedRole = new Role(stack, "Conv4SchedRole", {
  assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
});
schedRole.addToPolicy(
  new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [schedQueue.attrArn] }),
);
const schedule = new CfnSchedule(stack, "Conv4Schedule", {
  name: "cdkrd-hunt0714-conv4-sched",
  flexibleTimeWindow: { mode: "OFF" },
  scheduleExpression: "rate(12 hours)",
  target: { arn: schedQueue.attrArn, roleArn: schedRole.roleArn },
});
schedule.node.addDependency(schedRole);

// Glue crawler: barest S3-target crawler (never runs).
const crawlBucket = new Bucket(stack, "Conv4CrawlBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
});
const glueRole = new Role(stack, "Conv4GlueRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
});
crawlBucket.grantRead(glueRole);
new CfnDatabase(stack, "Conv4GlueDb", {
  catalogId: stack.account,
  databaseInput: { name: "cdkrd_hunt0714_conv4_db" },
});
new CfnCrawler(stack, "Conv4Crawler", {
  name: "cdkrd-hunt0714-conv4-crawler",
  role: glueRole.roleArn,
  databaseName: "cdkrd_hunt0714_conv4_db",
  targets: { s3Targets: [{ path: `s3://${crawlBucket.bucketName}/data/` }] },
});

// Pipes: barest SQS -> SQS pipe.
const pipeSrc = new CfnQueue(stack, "Conv4PipeSrc", {});
const pipeDst = new CfnQueue(stack, "Conv4PipeDst", {});
const pipeRole = new Role(stack, "Conv4PipeRole", {
  assumedBy: new ServicePrincipal("pipes.amazonaws.com"),
});
pipeRole.addToPolicy(
  new PolicyStatement({
    actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
    resources: [pipeSrc.attrArn],
  }),
);
pipeRole.addToPolicy(
  new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [pipeDst.attrArn] }),
);
const pipe = new CfnPipe(stack, "Conv4Pipe", {
  name: "cdkrd-hunt0714-conv4-pipe",
  roleArn: pipeRole.roleArn,
  source: pipeSrc.attrArn,
  target: pipeDst.attrArn,
});
pipe.node.addDependency(pipeRole);

app.synth();

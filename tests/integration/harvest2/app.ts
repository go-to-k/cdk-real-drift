// Corpus-harvest fixture wave 2 (R73): RICHLY-DECLARED configurations. Wave 1
// (harvest/) covered fresh default-config types; the remaining declared-compare
// false-positive surface is DEEPLY NESTED declared structs (lifecycle rules,
// GSIs, redrive policies, input transformers, WAF statements) — a fresh deploy
// of THIS stack must classify with zero declared drift, which stresses the
// canonicalization pipeline on every shape at once. Also deliberately declares
// NON-default values for properties that KNOWN_DEFAULTS suppresses (tracing,
// memory, timeout, architectures) so the declared loop sees them, and a KMS
// managed alias (alias/aws/kinesis) so the strict alias<->key-ARN match runs
// against real ListAliases data. Everything cheap and self-cleaning.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Cluster } from "aws-cdk-lib/aws-ecs";
import { Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { Stream, StreamEncryption } from "aws-cdk-lib/aws-kinesis";
import { Architecture, Code, Function as Fn, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, HttpMethods, StorageClass } from "aws-cdk-lib/aws-s3";
import { SubscriptionFilter, Topic } from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { DeduplicationScope, Queue } from "aws-cdk-lib/aws-sqs";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegHarvest2");

new Bucket(stack, "Archive", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  lifecycleRules: [
    {
      id: "tier-then-expire",
      prefix: "logs/",
      transitions: [
        { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
        { storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(90) },
      ],
      expiration: Duration.days(365),
    },
    { id: "mpu-cleanup", abortIncompleteMultipartUploadAfter: Duration.days(7) },
  ],
  cors: [
    {
      allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
      allowedOrigins: ["https://example.com"],
      allowedHeaders: ["*"],
      maxAge: 300,
    },
  ],
});

new Table(stack, "Orders", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.NUMBER },
  billingMode: BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "expiresAt",
  stream: StreamViewType.NEW_AND_OLD_IMAGES,
  removalPolicy: RemovalPolicy.DESTROY,
}).addGlobalSecondaryIndex({
  indexName: "byStatus",
  partitionKey: { name: "status", type: AttributeType.STRING },
  projectionType: ProjectionType.KEYS_ONLY,
});

new Fn(stack, "Worker", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => 'harvest2';"),
  memorySize: 256,
  timeout: Duration.seconds(20),
  architecture: Architecture.ARM_64,
  tracing: Tracing.ACTIVE,
  environment: { STAGE: "harvest", FEATURE_X: "on" },
});

const dlq = new Queue(stack, "JobsDlq", { fifo: true });
new Queue(stack, "Jobs", {
  fifo: true,
  contentBasedDeduplication: true,
  deduplicationScope: DeduplicationScope.MESSAGE_GROUP,
  visibilityTimeout: Duration.seconds(45),
  deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
});

const alerts = new Topic(stack, "Alerts"); // standard topic so SQS sub + filter policy work
const inbox = new Queue(stack, "Inbox");
alerts.addSubscription(
  new SqsSubscription(inbox, {
    rawMessageDelivery: true,
    filterPolicy: {
      severity: SubscriptionFilter.stringFilter({ allowlist: ["high", "critical"] }),
    },
  })
);

new Rule(stack, "Forward", {
  schedule: Schedule.rate(Duration.hours(6)),
  enabled: false,
  targets: [
    new SqsQueue(inbox, {
      message: RuleTargetInput.fromObject({ source: "harvest2", kind: "tick" }),
    }),
  ],
});

new CfnWebACL(stack, "Edge", {
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: "harvest2",
    sampledRequestsEnabled: false,
  },
  rules: [
    {
      name: "common",
      priority: 0,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "common",
        sampledRequestsEnabled: false,
      },
    },
  ],
});

new Alarm(stack, "Latency", {
  metric: new Metric({
    namespace: "CdkrdHarvest2",
    metricName: "Latency",
    period: Duration.minutes(5),
  }),
  threshold: 250,
  evaluationPeriods: 3,
  datapointsToAlarm: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
});

new Cluster(stack, "Workers", { containerInsights: true });

new Stream(stack, "Events", {
  shardCount: 1,
  retentionPeriod: Duration.hours(48),
  encryption: StreamEncryption.MANAGED, // alias/aws/kinesis -> strict alias<->key-ARN match, live
});

app.synth();

// Corpus-harvest fixture wave 3 (R74): NEW SERVICE FAMILIES + a multi-type
// REVERT MATRIX. Waves 1-2 covered default-config breadth and deeply-declared
// structs; this wave adds service families the corpus has never seen live
// (Cognito, KMS, Secrets Manager, EventBridge Scheduler, Firehose, SES,
// Cloud Map, AppSync, CloudTrail, AWS Backup) AND five Cloud-Control-routed
// "matrix" resources (Lambda / SQS / Logs / SNS / Events) whose declared
// values the verify script mutates out-of-band and reverts in ONE
// `revert --yes` — the first live proof that CC UpdateResource converges
// across many types at once (the previous revert integ was S3-only).
// Everything is cheap, fast to deploy, and self-cleaning.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnGraphQLApi } from "aws-cdk-lib/aws-appsync";
import { BackupPlan, BackupVault } from "aws-cdk-lib/aws-backup";
import { Trail } from "aws-cdk-lib/aws-cloudtrail";
import { AccountRecovery, UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { Alias, Key } from "aws-cdk-lib/aws-kms";
import { Code, Function as Fn, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { CfnSchedule, CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnConfigurationSet } from "aws-cdk-lib/aws-ses";
import { HttpNamespace } from "aws-cdk-lib/aws-servicediscovery";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegHarvest3");

// ---- revert-matrix targets (all Cloud-Control routed; the verify script
// ---- mutates each declared value out-of-band, then one revert restores all 5)
const matrixFn = new Fn(stack, "MatrixFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => 'harvest3';"),
  memorySize: 256, // matrix M1: out-of-band 512 -> revert -> 256
  timeout: Duration.seconds(10),
});

new Queue(stack, "MatrixQueue", {
  visibilityTimeout: Duration.seconds(60), // matrix M2: out-of-band 120 -> revert -> 60
  retentionPeriod: Duration.days(4),
});

new LogGroup(stack, "MatrixLogs", {
  retention: RetentionDays.ONE_WEEK, // matrix M3: out-of-band 30 -> revert -> 7
  removalPolicy: RemovalPolicy.DESTROY,
});

const matrixTopic = new Topic(stack, "MatrixTopic", {
  displayName: "cdkrd harvest3 matrix", // matrix M4: out-of-band rename -> revert
});

new Rule(stack, "MatrixRule", {
  schedule: Schedule.rate(Duration.hours(1)),
  enabled: true, // matrix M5: out-of-band disable-rule -> revert -> ENABLED
});

// ---- new service families (harvest-only: deploy -> zero declared drift ->
// ---- accept -> CLEAN -> record corpus -> destroy)
const pool = new UserPool(stack, "Users", {
  selfSignUpEnabled: false,
  accountRecovery: AccountRecovery.EMAIL_ONLY,
  passwordPolicy: {
    minLength: 12,
    requireDigits: true,
    requireSymbols: true,
    tempPasswordValidity: Duration.days(3),
  },
  removalPolicy: RemovalPolicy.DESTROY,
});
new UserPoolClient(stack, "WebClient", {
  userPool: pool,
  authFlows: { userSrp: true },
  generateSecret: false,
});

const key = new Key(stack, "DataKey", {
  description: "cdkrd harvest3 data key",
  enableKeyRotation: true,
  pendingWindow: Duration.days(7),
  removalPolicy: RemovalPolicy.DESTROY,
});
new Alias(stack, "DataKeyAlias", { aliasName: "alias/cdkrd-harvest3", targetKey: key });

new Secret(stack, "AppSecret", {
  description: "cdkrd harvest3 secret",
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: "app" }),
    generateStringKey: "password",
    excludePunctuation: true,
  },
  removalPolicy: RemovalPolicy.DESTROY,
});

const schedGroup = new CfnScheduleGroup(stack, "SchedGroup", {
  name: "cdkrd-harvest3",
});
const schedRole = new Role(stack, "SchedRole", {
  assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
});
schedRole.addToPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["sns:Publish"],
    resources: [matrixTopic.topicArn],
  })
);
new CfnSchedule(stack, "HourlyPing", {
  groupName: schedGroup.name,
  scheduleExpression: "rate(1 hour)",
  flexibleTimeWindow: { mode: "OFF" },
  state: "DISABLED", // never actually publish
  target: { arn: matrixTopic.topicArn, roleArn: schedRole.roleArn },
}).addDependency(schedGroup);

const sink = new Bucket(stack, "FirehoseSink", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
});
const firehoseRole = new Role(stack, "FirehoseRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
});
sink.grantReadWrite(firehoseRole);
new CfnDeliveryStream(stack, "Tap", {
  deliveryStreamType: "DirectPut",
  s3DestinationConfiguration: {
    bucketArn: sink.bucketArn,
    roleArn: firehoseRole.roleArn,
    bufferingHints: { intervalInSeconds: 300, sizeInMBs: 5 },
    compressionFormat: "GZIP",
  },
});

new CfnConfigurationSet(stack, "Mailer", { name: "cdkrd-harvest3" });

new HttpNamespace(stack, "Mesh", {
  name: "cdkrd-harvest3",
  description: "cdkrd harvest3 http namespace",
});

new CfnGraphQLApi(stack, "Graph", {
  name: "cdkrd-harvest3",
  authenticationType: "API_KEY",
});

const auditBucket = new Bucket(stack, "AuditLogs", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
});
new Trail(stack, "Audit", {
  bucket: auditBucket,
  isMultiRegionTrail: false,
  includeGlobalServiceEvents: false,
});

const vault = new BackupVault(stack, "Vault", {
  removalPolicy: RemovalPolicy.DESTROY,
});
BackupPlan.daily35DayRetention(stack, "Plan", vault);

// keep the matrix Lambda referenced so oxc/tsgo never flag it unused
void matrixFn;

app.synth();

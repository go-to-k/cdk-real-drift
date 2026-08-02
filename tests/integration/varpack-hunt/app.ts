// CDK app for the cdk-real-drift varpack-hunt integration test (2026-08-03 hunt).
// Barest deploys of eight genuinely-unexercised, ~$0 variants (offline audit
// 2026-08-03) — each probes a first-run fold / read surface no fixture or corpus
// case has ever exercised:
//   - ECS TaskDefinition (FARGATE) WITH RuntimePlatform ARM64 + one WITHOUT
//     (RuntimePlatform / EphemeralStorage first-run echoes; createOnly nested object)
//   - SNS Subscription Protocol=email, never confirmed. DETERMINATION (2026-08-03):
//     the feared literal "pending confirmation" physical id did NOT materialize —
//     CloudFormation now mints a REAL subscription ARN for a pending email sub, the
//     CC read succeeds, and the resource classifies clean (the inventory-side guard
//     at child-enumerators.ts:1623 remains the only place the placeholder appears)
//   - SSM Parameter Type=StringList (comma-joined Value round-trip)
//   - EC2 LaunchTemplate with InstanceMarketOptions.MarketType=spot (barest —
//     SpotOptions undeclared; service-fill probe)
//   - Batch ComputeEnvironment Type=UNMANAGED (no ComputeResources at all)
//   - Logs LogGroup LogGroupClass=DELIVERY (third class; STANDARD + IA covered)
//   - Glue Job Command.Name=gluestreaming (mirrored, live-unproven fold-table row:
//     noise.ts reasons about gluestreaming defaults from glueetl evidence only)
//   - Firehose DeliveryStreamType=KinesisStreamAsSource (source-config echo; every
//     existing Firehose case is DirectPut)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnComputeEnvironment } from "aws-cdk-lib/aws-batch";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import { CfnLaunchTemplate } from "aws-cdk-lib/aws-ec2";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { CfnJob } from "aws-cdk-lib/aws-glue";
import { ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnParameter } from "aws-cdk-lib/aws-ssm";
import { CfnSubscription, Topic } from "aws-cdk-lib/aws-sns";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0803VarPack");

// ── ECS TaskDefinition: ARM64 declared + sibling with RuntimePlatform undeclared ──
const containerDefs = [
  { name: "app", image: "public.ecr.aws/docker/library/busybox:latest", essential: true },
];
new CfnTaskDefinition(stack, "ArmTaskDef", {
  family: "cdkrd-hunt-arm-0803",
  requiresCompatibilities: ["FARGATE"],
  cpu: "256",
  memory: "512",
  networkMode: "awsvpc",
  runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
  containerDefinitions: containerDefs,
});
new CfnTaskDefinition(stack, "BareTaskDef", {
  family: "cdkrd-hunt-bare-0803",
  requiresCompatibilities: ["FARGATE"],
  cpu: "256",
  memory: "512",
  networkMode: "awsvpc",
  containerDefinitions: containerDefs,
});

// ── SNS email subscription that will never be confirmed ────────────────────
const topic = new Topic(stack, "HuntTopic", { topicName: "cdkrd-hunt-varpack-0803" });
new CfnSubscription(stack, "EmailSub", {
  topicArn: topic.topicArn,
  protocol: "email",
  endpoint: "cdkrd-test@example.com",
});

// ── SSM StringList parameter ────────────────────────────────────────────────
new CfnParameter(stack, "ListParam", {
  name: "cdkrd-hunt-varpack-0803-list",
  type: "StringList",
  value: "alpha,beta,gamma",
});

// ── Spot launch template (SpotOptions undeclared) ──────────────────────────
new CfnLaunchTemplate(stack, "SpotLt", {
  launchTemplateName: "cdkrd-hunt-varpack-0803-lt",
  launchTemplateData: {
    instanceType: "t3.nano",
    instanceMarketOptions: { marketType: "spot" },
  },
});

// ── UNMANAGED Batch compute environment ────────────────────────────────────
// Create-time axis finding: an UNMANAGED CE REJECTS a missing ServiceRole
// ("ServiceRole is required") — the MANAGED variant's service-linked-role
// fallback does not apply to UNMANAGED.
const batchRole = new Role(stack, "BatchServiceRole", {
  assumedBy: new ServicePrincipal("batch.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSBatchServiceRole")],
});
new CfnComputeEnvironment(stack, "UnmanagedCe", {
  computeEnvironmentName: "cdkrd-hunt-varpack-0803-ce",
  type: "UNMANAGED",
  serviceRole: batchRole.roleArn,
});

// ── DELIVERY-class log group ────────────────────────────────────────────────
new CfnLogGroup(stack, "DeliveryLg", {
  logGroupName: "cdkrd-hunt-varpack-0803-delivery",
  logGroupClass: "DELIVERY",
});

// ── gluestreaming job (definition only — never run) ────────────────────────
const glueRole = new Role(stack, "GlueRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
});
new CfnJob(stack, "StreamingJob", {
  name: "cdkrd-hunt-varpack-0803-streaming",
  role: glueRole.roleArn,
  command: {
    name: "gluestreaming",
    scriptLocation: "s3://cdkrd-hunt-varpack-0803-nonexistent/script.py",
  },
});

// ── Firehose KinesisStreamAsSource (zero ingest) ───────────────────────────
const srcStream = new CfnStream(stack, "SrcStream", {
  name: "cdkrd-hunt-varpack-0803-src",
  shardCount: 1,
});
const destBucket = new Bucket(stack, "FirehoseDest", {
  bucketName: "cdkrd-hunt-varpack-0803-x9z7q",
  removalPolicy: RemovalPolicy.DESTROY,
});
// Firehose VALIDATES role permissions at create — inline policies (part of the
// role create) avoid the grant()-attachment race (variants3-hunt lesson).
const fhRole = new Role(stack, "FirehoseRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
  inlinePolicies: {
    access: new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"],
          resources: [destBucket.bucketArn, `${destBucket.bucketArn}/*`],
        }),
        new PolicyStatement({
          actions: ["kinesis:DescribeStream", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:ListShards"],
          resources: [srcStream.attrArn],
        }),
      ],
    }),
  },
});
new CfnDeliveryStream(stack, "KinesisSourced", {
  deliveryStreamName: "cdkrd-hunt-varpack-0803-fh",
  deliveryStreamType: "KinesisStreamAsSource",
  kinesisStreamSourceConfiguration: {
    kinesisStreamArn: srcStream.attrArn,
    roleArn: fhRole.roleArn,
  },
  extendedS3DestinationConfiguration: {
    bucketArn: destBucket.bucketArn,
    roleArn: fhRole.roleArn,
  },
});

app.synth();

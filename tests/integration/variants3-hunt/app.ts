// Variant-axis first-run FP probe batch 3 (real AWS): barest forms of variant
// branches whose sibling variants are covered but whose OWN default family has
// never been read live (the #1477/#1487/Firehose-HTTP class — folds built from
// one variant miss the others):
// - Firehose IcebergDestinationConfiguration (ExtendedS3 + HttpEndpoint covered;
//   Iceberg carries its own nested S3/buffering/retry echo family)
// - Batch ComputeEnvironment FARGATE_SPOT (EC2 + FARGATE covered)
// - CodeBuild LINUX_LAMBDA_CONTAINER + ARM_CONTAINER (LINUX_CONTAINER only so far)
// - ELBv2 Listener default action `redirect` (forward + fixed-response covered;
//   RedirectConfig materializes "#{host}"/"#{path}"/"#{port}"/"#{query}" defaults)
// - Scheduler FlexibleTimeWindow FLEXIBLE mode (both corpus schedules are OFF)
import { App, Fn, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnComputeEnvironment } from "aws-cdk-lib/aws-batch";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { CfnSecurityGroup, CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import {
  CfnListener,
  CfnLoadBalancer,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Variants3");

// --- minimal VPC (2 subnets for the ALB; no IGW/NAT — the ALB is internal) ---
const vpc = new CfnVPC(stack, "Var3Vpc", { cidrBlock: "10.0.0.0/16" });
const subnet1 = new CfnSubnet(stack, "Var3Subnet1", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.0.0/24",
  availabilityZone: Fn.select(0, Fn.getAzs()),
});
const subnet2 = new CfnSubnet(stack, "Var3Subnet2", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: Fn.select(1, Fn.getAzs()),
});

// --- ELBv2 Listener with a barest `redirect` default action ---
const alb = new CfnLoadBalancer(stack, "Var3Alb", {
  scheme: "internal",
  type: "application",
  subnets: [subnet1.ref, subnet2.ref],
});
new CfnListener(stack, "Var3RedirectListener", {
  loadBalancerArn: alb.ref,
  port: 80,
  protocol: "HTTP",
  defaultActions: [
    {
      type: "redirect",
      // Only the required modification (Protocol) + StatusCode are declared;
      // Host/Path/Port/Query stay undeclared to probe their "#{...}" echoes.
      redirectConfig: { statusCode: "HTTP_301", protocol: "HTTPS" },
    },
  ],
});

// --- Batch FARGATE_SPOT compute environment (barest) ---
const batchSg = new CfnSecurityGroup(stack, "Var3BatchSg", {
  groupDescription: "cdkrd hunt0714 var3 batch",
  vpcId: vpc.ref,
});
new CfnComputeEnvironment(stack, "Var3SpotCe", {
  type: "MANAGED",
  computeResources: {
    type: "FARGATE_SPOT",
    maxvCpus: 1,
    subnets: [subnet1.ref],
    securityGroupIds: [batchSg.attrGroupId],
  },
});

// --- CodeBuild Lambda-compute + ARM projects (barest) ---
const cbRole = new Role(stack, "Var3CbRole", {
  assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
});
new CfnProject(stack, "Var3LambdaCb", {
  name: "cdkrd-hunt0714-var3-cb-lambda",
  serviceRole: cbRole.roleArn,
  source: { type: "NO_SOURCE", buildSpec: '{"version":"0.2","phases":{}}' },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_LAMBDA_CONTAINER",
    computeType: "BUILD_LAMBDA_1GB",
    image: "aws/codebuild/amazonlinux-x86_64-lambda-standard:nodejs20",
  },
});
new CfnProject(stack, "Var3ArmCb", {
  name: "cdkrd-hunt0714-var3-cb-arm",
  serviceRole: cbRole.roleArn,
  source: { type: "NO_SOURCE", buildSpec: '{"version":"0.2","phases":{}}' },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "ARM_CONTAINER",
    computeType: "BUILD_GENERAL1_SMALL",
    image: "aws/codebuild/amazonlinux2-aarch64-standard:3.0",
  },
});

// --- Firehose Iceberg destination (barest REACHABLE form; DirectPut, no
// producers). Deploy-time determination: a table-less Iceberg destination is
// REJECTED at create ("A single default destination table configuration must
// be provided when both Lambda and MetadataExtraction processors are not
// provided"), so DestinationTableConfigurationList is part of the barest
// form; everything else (buffering / retry / backup mode / logging) stays
// undeclared to probe the per-variant echo family. ---
const icebergBucket = new Bucket(stack, "Var3IcebergBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
});
// Inline policies (not grant()-style attached policies): Firehose VALIDATES the
// role's glue/s3 access at create, and a separate AWS::IAM::Policy resource can
// land after that validation — inline policies are part of the role create.
const fhRole = new Role(stack, "Var3FhRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
  inlinePolicies: {
    iceberg: new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: [
            "glue:GetDatabase",
            "glue:GetTable",
            "glue:GetTableVersion",
            "glue:GetTableVersions",
            "glue:UpdateTable",
          ],
          resources: ["*"],
        }),
        new PolicyStatement({
          actions: ["s3:*"],
          resources: [icebergBucket.bucketArn, `${icebergBucket.bucketArn}/*`],
        }),
      ],
    }),
  },
});
const icebergDb = new CfnDatabase(stack, "Var3IcebergDb", {
  catalogId: stack.account,
  databaseInput: { name: "cdkrd_hunt0714_var3_db" },
});
const icebergTable = new CfnTable(stack, "Var3IcebergTable", {
  catalogId: stack.account,
  databaseName: "cdkrd_hunt0714_var3_db",
  openTableFormatInput: {
    icebergInput: { metadataOperation: "CREATE", version: "2" },
  },
  tableInput: {
    name: "cdkrd_hunt0714_var3_tbl",
    tableType: "EXTERNAL_TABLE",
    storageDescriptor: {
      columns: [{ name: "id", type: "string" }],
      location: `s3://${icebergBucket.bucketName}/table/`,
    },
  },
});
icebergTable.addDependency(icebergDb);
const firehose = new CfnDeliveryStream(stack, "Var3IcebergFirehose", {
  deliveryStreamName: "cdkrd-hunt0714-var3-iceberg",
  deliveryStreamType: "DirectPut",
  icebergDestinationConfiguration: {
    roleArn: fhRole.roleArn,
    catalogConfiguration: {
      catalogArn: `arn:aws:glue:${stack.region}:${stack.account}:catalog`,
    },
    destinationTableConfigurationList: [
      {
        destinationDatabaseName: "cdkrd_hunt0714_var3_db",
        destinationTableName: "cdkrd_hunt0714_var3_tbl",
      },
    ],
    s3Configuration: {
      bucketArn: icebergBucket.bucketArn,
      roleArn: fhRole.roleArn,
    },
  },
});
firehose.addDependency(icebergTable);

// --- Scheduler FLEXIBLE time window (barest) ---
const schedQueue = new CfnQueue(stack, "Var3SchedQueue", {});
const schedRole = new Role(stack, "Var3SchedRole", {
  assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
});
schedRole.addToPolicy(
  new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [schedQueue.attrArn] }),
);
const schedule = new CfnSchedule(stack, "Var3FlexSchedule", {
  name: "cdkrd-hunt0714-var3-flex",
  flexibleTimeWindow: { mode: "FLEXIBLE", maximumWindowInMinutes: 15 },
  scheduleExpression: "rate(12 hours)",
  target: { arn: schedQueue.attrArn, roleArn: schedRole.roleArn },
});
schedule.node.addDependency(schedRole);

app.synth();

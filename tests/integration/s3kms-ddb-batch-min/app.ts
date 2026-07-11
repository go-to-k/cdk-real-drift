// CDK app for the cdk-real-drift s3kms-ddb-batch-min false-positive
// integration test. BAREST-possible un-deployed variant branches:
// - AWS::S3::Bucket with SSE-KMS (aws/s3 managed key): corpus only covers
//   SSE-S3 / no-encryption — probes the BucketKeyEnabled / KMSMasterKeyID
//   echoes on the declared encryption block.
// - AWS::DynamoDB::Table minimal ON-DEMAND: BillingMode PAY_PER_REQUEST with
//   nothing else — probes on-demand-specific echoes
//   (BillingModeSummary/Throughput husks, WarmThroughput).
// - AWS::Batch::ComputeEnvironment MANAGED/EC2 with minvCpus 0 (no instances,
//   free): corpus only covers FARGATE — probes the EC2-branch default fill
//   (instance role echo, allocation strategy, launch template) and the
//   InstanceTypes set order.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnComputeEnvironment } from "aws-cdk-lib/aws-batch";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { CfnInstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegS3KmsDdbBatchMin");

const bucket = new CfnBucket(stack, "HuntKmsBucket", {
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      { serverSideEncryptionByDefault: { sseAlgorithm: "aws:kms" } },
    ],
  },
});
bucket.applyRemovalPolicy(RemovalPolicy.DESTROY);

new CfnTable(stack, "HuntOnDemandTable", {
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  attributeDefinitions: [{ attributeName: "pk", attributeType: "S" }],
  billingMode: "PAY_PER_REQUEST",
});

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const ecsRole = new Role(stack, "HuntBatchEcsRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
});
const profile = new CfnInstanceProfile(stack, "HuntBatchProfile", {
  instanceProfileName: "cdkrd-hunt-batch-profile",
  roles: [ecsRole.roleName],
});

const ce = new CfnComputeEnvironment(stack, "HuntEc2Ce", {
  type: "MANAGED",
  computeResources: {
    type: "EC2",
    maxvCpus: 4,
    minvCpus: 0,
    instanceTypes: ["m5.large", "c5.large"],
    instanceRole: profile.attrArn,
    subnets: vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds,
    securityGroupIds: [
      new SecurityGroup(stack, "HuntBatchSg", { vpc, allowAllOutbound: true }).securityGroupId,
    ],
  },
});
ce.addDependency(profile);

// CDK app for the cdk-real-drift S3 Express One Zone + S3 Tables false-positive
// test, plus three cheap 0-coverage riders. Every type here is CC-readable but
// absent from the golden corpus:
// - AWS::S3Express::DirectoryBucket + AWS::S3Express::BucketPolicy (S3 Express
//   One Zone directory buckets — fast-growing usage, zonal naming suffix).
// - AWS::S3Tables::TableBucket + AWS::S3Tables::TableBucketPolicy (Iceberg table
//   buckets with an explicit non-default UnreferencedFileRemoval config).
// - AWS::ECR::PullThroughCacheRule (public.ecr.aws upstream, no credentials).
// - AWS::Logs::LogAnomalyDetector (log anomaly detection on a log group).
// - AWS::EC2::PlacementGroup (spread/rack).
// A freshly deployed + recorded stack with NO out-of-band change MUST report
// CLEAN; any drift here is a normalization / default-folding FP.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnPlacementGroup } from "aws-cdk-lib/aws-ec2";
import { CfnPullThroughCacheRule } from "aws-cdk-lib/aws-ecr";
import { CfnLogAnomalyDetector, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnBucketPolicy, CfnDirectoryBucket } from "aws-cdk-lib/aws-s3express";
import { CfnTableBucket, CfnTableBucketPolicy } from "aws-cdk-lib/aws-s3tables";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3ExpressTables");

// Directory bucket names embed the availability-zone id: <base>--<az-id>--x-s3.
const dirBucketName = "cdkrd-hunt-lowcov--use1-az4--x-s3";
const dirBucket = new CfnDirectoryBucket(stack, "DirBucket", {
  bucketName: dirBucketName,
  locationName: "use1-az4",
  dataRedundancy: "SingleAvailabilityZone",
});

new CfnBucketPolicy(stack, "DirBucketPolicy", {
  bucket: dirBucket.ref,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3express:*",
        Resource: `arn:aws:s3express:${stack.region}:${stack.account}:bucket/${dirBucketName}`,
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  },
});

const tableBucket = new CfnTableBucket(stack, "TableBucket", {
  tableBucketName: "cdkrd-hunt-lowcov-tables",
  // Non-default maintenance config to exercise the nested round-trip.
  unreferencedFileRemoval: {
    status: "Enabled",
    unreferencedDays: 10,
    noncurrentDays: 5,
  },
});

new CfnTableBucketPolicy(stack, "TableBucketPolicy", {
  tableBucketArn: tableBucket.attrTableBucketArn,
  resourcePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowOwnerRead",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${stack.account}:root` },
        Action: ["s3tables:GetTableBucket"],
        Resource: tableBucket.attrTableBucketArn,
      },
    ],
  },
});

new CfnPullThroughCacheRule(stack, "EcrPublicPtc", {
  ecrRepositoryPrefix: "cdkrd-hunt-ecrpub",
  upstreamRegistryUrl: "public.ecr.aws",
});

const logGroup = new LogGroup(stack, "AnomalyLg", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

new CfnLogAnomalyDetector(stack, "AnomalyDetector", {
  detectorName: "cdkrd-hunt-anomaly",
  // LogGroup.logGroupArn ends in ":*" — build the plain log-group ARN instead.
  logGroupArnList: [
    `arn:aws:logs:${stack.region}:${stack.account}:log-group:${logGroup.logGroupName}`,
  ],
  anomalyVisibilityTime: 14,
  evaluationFrequency: "ONE_HOUR",
});

new CfnPlacementGroup(stack, "Spread", {
  strategy: "spread",
  spreadLevel: "rack",
});

app.synth();

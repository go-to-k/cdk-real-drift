// CDK app for the cdk-real-drift S3 Object Lock false-positive test. Object Lock
// (WORM / compliance retention) is a common but not-yet-exercised S3 sub-config:
// it adds an ObjectLockEnabled flag plus a nested ObjectLockConfiguration.Rule.
// DefaultRetention block (Mode + Days/Years) that AWS materializes on read. A
// freshly deployed + recorded bucket with NO out-of-band change MUST report CLEAN
// — any drift here is a normalization / default-folding FP on the Object Lock
// shape. Object Lock requires versioning, so this also exercises the
// VersioningConfiguration round-trip alongside an explicit bucket-key encryption.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockRetention,
} from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3ObjectLock");

new Bucket(stack, "Locked", {
  // Object Lock requires versioning; CDK enables it implicitly with
  // objectLockEnabled, but declare it explicitly to exercise the round-trip.
  versioned: true,
  objectLockEnabled: true,
  objectLockDefaultRetention: ObjectLockRetention.governance(Duration.days(30)),
  encryption: BucketEncryption.S3_MANAGED,
  bucketKeyEnabled: false,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  // Empty bucket: no autoDeleteObjects custom resource needed, so teardown
  // leaves no orphaned /aws/lambda/* log group.
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

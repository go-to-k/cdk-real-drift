// CDK app for the cdk-real-drift richly-configured EFS file system false-positive
// test. EFS is a near-universal companion to Fargate / Lambda / EC2 workloads, yet
// existing coverage is only the mount-target child enumerator (efs-mounttarget-added)
// and the harvest snapshot corpus — never a deploy-verified FP integ of the file
// system resource itself. This one exercises the knobs that each add a normalization
// edge: a BackupPolicy (a nested {Status} sub-object that AWS stores as a SEPARATE
// associated resource yet CFn surfaces inline — the FN oracle in verify-detect.sh
// toggles it), LifecyclePolicies (an ARRAY of single-key objects — the classic
// array/ordering edge), Encrypted + a KMS key intrinsic ref, PerformanceMode /
// ThroughputMode enums, and FileSystemProtection (a nested ReplicationOverwrite
// protection enum). A freshly deployed + recorded file system with NO out-of-band
// change MUST report CLEAN.
//
// Uses the L1 CfnFileSystem directly: a bare file system needs no VPC and no mount
// targets (those are the efs-mounttarget-added fixture's job), so it deploys in
// seconds and keeps the test focused on the resource's own property normalization.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnFileSystem } from "aws-cdk-lib/aws-efs";
import { Key } from "aws-cdk-lib/aws-kms";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEfsRich");

const key = new Key(stack, "FsKey", {
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

const fs = new CfnFileSystem(stack, "Fs", {
  encrypted: true,
  kmsKeyId: key.keyArn,
  performanceMode: "generalPurpose",
  throughputMode: "bursting",
  backupPolicy: { status: "ENABLED" },
  lifecyclePolicies: [
    { transitionToIa: "AFTER_30_DAYS" },
    { transitionToPrimaryStorageClass: "AFTER_1_ACCESS" },
  ],
  fileSystemProtection: { replicationOverwriteProtection: "ENABLED" },
  fileSystemTags: [
    { key: "team", value: "platform" },
    { key: "cost-center", value: "1234" },
  ],
});
fs.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

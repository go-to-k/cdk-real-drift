// CDK app for the cdk-real-drift datasync-rich false-positive integration test.
// AWS DataSync (AWS::DataSync::LocationS3 + ::Task) is a common data-migration
// service. A Task folds a large Options block of AWS-assigned defaults — VerifyMode,
// OverwriteMode, Atime, Mtime, Uid, Gid, PreserveDeletedFiles, PosixPermissions,
// TaskQueueing, LogLevel, TransferMode, ObjectTags, etc. — none of which the user
// declares. A LocationS3 folds S3StorageClass + a normalized Subdirectory. A clean
// `record`->`check` is a strong false-positive oracle for those undeclared defaults.
import { App, Stack } from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";
import { CfnLocationS3, CfnTask } from "aws-cdk-lib/aws-datasync";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDataSyncRich");

const src = new Bucket(stack, "Src", {
  bucketName: `cdkrd-ds-src-${stack.account}`,
  removalPolicy: RemovalPolicy.DESTROY,
});
const dst = new Bucket(stack, "Dst", {
  bucketName: `cdkrd-ds-dst-${stack.account}`,
  removalPolicy: RemovalPolicy.DESTROY,
});

const role = new Role(stack, "DsRole", {
  assumedBy: new ServicePrincipal("datasync.amazonaws.com"),
});
role.addToPolicy(
  new PolicyStatement({
    actions: [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectTagging",
      "s3:PutObjectTagging",
      "s3:ListMultipartUploadParts",
      "s3:AbortMultipartUpload",
    ],
    resources: [src.bucketArn, `${src.bucketArn}/*`, dst.bucketArn, `${dst.bucketArn}/*`],
  })
);

const srcLoc = new CfnLocationS3(stack, "SrcLoc", {
  s3BucketArn: src.bucketArn,
  s3Config: { bucketAccessRoleArn: role.roleArn },
  subdirectory: "/in",
});
// Depend on the whole Role construct (incl. its DefaultPolicy), not just the Role
// resource — DataSync runs an s3:ListObjectsV2 access test at location-create time,
// so the inline policy must exist first or the create fails "Access denied".
srcLoc.node.addDependency(role);

const dstLoc = new CfnLocationS3(stack, "DstLoc", {
  s3BucketArn: dst.bucketArn,
  s3Config: { bucketAccessRoleArn: role.roleArn },
  subdirectory: "/out",
});
dstLoc.node.addDependency(role);

new CfnTask(stack, "Task", {
  name: "cdkrd-ds-task",
  sourceLocationArn: srcLoc.ref,
  destinationLocationArn: dstLoc.ref,
  options: {
    verifyMode: "ONLY_FILES_TRANSFERRED",
    overwriteMode: "ALWAYS",
    transferMode: "CHANGED",
    logLevel: "OFF",
  },
});

app.synth();

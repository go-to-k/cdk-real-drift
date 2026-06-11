// Revert integration fixture: a versioned S3 bucket. verify.sh injects both a
// DECLARED drift (versioning) and an UNDECLARED drift (transfer acceleration),
// then `cdkrd revert` should restore both via Cloud Control UpdateResource.
import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';

const app = new App();
const stack = new Stack(app, 'CdkRealDriftIntegRevert');
new Bucket(stack, 'Data', {
  versioned: true,
  encryption: BucketEncryption.S3_MANAGED,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
app.synth();

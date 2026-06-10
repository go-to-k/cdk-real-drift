// Minimal CDK app for the cdkdrift basic integration test.
// One versioned S3 bucket (CC-API readable, undeclared-property-rich).
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';

const app = new App();
const stack = new Stack(app, 'CdkdriftIntegBasic');
new Bucket(stack, 'Data', {
  versioned: true,
  encryption: BucketEncryption.S3_MANAGED,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
app.synth();

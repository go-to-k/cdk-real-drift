// CDK app for the cdk-real-drift S3 Access Point false-positive test.
// AWS::S3::AccessPoint is a common way to expose a bucket with a scoped policy +
// hardened public-access block, and is not yet covered by any fixture. A fresh
// access point ships a full default PublicAccessBlockConfiguration and a
// NetworkOrigin the template may not declare; a freshly deployed + recorded
// stack with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnAccessPoint } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3AccessPoint");

const bucket = new Bucket(stack, "Data", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

new CfnAccessPoint(stack, "Ap", {
  bucket: bucket.bucketName,
  name: "cdkrd-ap",
  publicAccessBlockConfiguration: {
    blockPublicAcls: true,
    ignorePublicAcls: true,
    blockPublicPolicy: true,
    restrictPublicBuckets: true,
  },
  policy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: stack.account },
        Action: ["s3:GetObject"],
        Resource: `arn:aws:s3:${stack.region}:${stack.account}:accesspoint/cdkrd-ap/object/*`,
      },
    ],
  },
});

app.synth();

// cdk-real-drift s3-events FP integration test. Exercises S3 config surfaces NOT in
// s3-rich: EventBridge notifications, transfer acceleration, a metrics configuration,
// BUCKET_OWNER_ENFORCED ownership, and the enforceSSL bucket policy — all default- and
// nested-config-heavy, a strong false-positive oracle for a very common resource.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3Events");
new Bucket(stack, "B", {
  bucketName: "cdkrd-s3-events-fixture",
  eventBridgeEnabled: true,
  transferAcceleration: true,
  versioned: true,
  enforceSSL: true,
  encryption: BucketEncryption.S3_MANAGED,
  objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
  metrics: [{ id: "EntireBucket" }],
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
app.synth();

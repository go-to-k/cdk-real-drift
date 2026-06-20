// CDK app for the cdk-real-drift CloudTrail false-positive test. A CloudTrail
// trail is a common audit/compliance resource with several boolean/enum knobs
// (IncludeGlobalServiceEvents, IsMultiRegionTrail, EnableLogFileValidation) plus
// an auto-managed S3 destination bucket + bucket policy. CloudTrail has never
// been exercised by a focused fixture. A freshly deployed + recorded trail with
// NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Trail } from "aws-cdk-lib/aws-cloudtrail";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCloudTrailRich");

const bucket = new Bucket(stack, "TrailBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

new Trail(stack, "Trail", {
  bucket,
  trailName: "cdkrd-cloudtrail-rich",
  includeGlobalServiceEvents: true,
  isMultiRegionTrail: false,
  enableFileValidation: true,
});

app.synth();

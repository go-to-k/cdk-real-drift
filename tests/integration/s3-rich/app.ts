// CDK app for the cdk-real-drift richly-configured S3 false-positive test.
// S3 is the single most commonly deployed CDK resource; a richly configured bucket
// exercises many normalization edges at once (lifecycle rules, CORS, KMS encryption
// with bucket keys, intelligent tiering, object ownership, enforced SSL bucket
// policy, public access block). A freshly deployed + recorded bucket with NO
// out-of-band change MUST report CLEAN.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
  StorageClass,
} from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3Rich");

new Bucket(stack, "Data", {
  versioned: true,
  encryption: BucketEncryption.KMS,
  bucketKeyEnabled: true,
  enforceSSL: true,
  objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  cors: [
    {
      allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
      allowedOrigins: ["https://example.com"],
      allowedHeaders: ["*"],
      maxAge: 3000,
    },
  ],
  lifecycleRules: [
    {
      id: "archive",
      enabled: true,
      abortIncompleteMultipartUploadAfter: Duration.days(7),
      transitions: [
        { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
        { storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(90) },
      ],
      noncurrentVersionExpiration: Duration.days(365),
      expiration: Duration.days(730),
    },
  ],
  intelligentTieringConfigurations: [
    {
      name: "archive-tiers",
      archiveAccessTierTime: Duration.days(90),
      deepArchiveAccessTierTime: Duration.days(180),
    },
  ],
});

app.synth();

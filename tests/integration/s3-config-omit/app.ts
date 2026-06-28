// CDK app probing whether the OMITTED_WHEN_EMPTY false-negative class extends to
// S3 bucket sub-configs (the MOST common resource): CorsConfiguration and
// LifecycleConfiguration declared, then removed out of band
// (`aws s3api delete-bucket-cors` / `delete-bucket-lifecycle`). If Cloud Control
// OMITS these top-level keys once removed, the declared config's removal would
// misclassify as a readGap -> CLEAN -> silent FN.
import { App, Duration, Stack } from "aws-cdk-lib";
import { Bucket, HttpMethods } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3ConfigOmit");

new Bucket(stack, "Bucket", {
  cors: [
    {
      allowedMethods: [HttpMethods.GET],
      allowedOrigins: ["https://example.com"],
      allowedHeaders: ["*"],
    },
  ],
  lifecycleRules: [{ id: "expire-90", expiration: Duration.days(90) }],
});

app.synth();

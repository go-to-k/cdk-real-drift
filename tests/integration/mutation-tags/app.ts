// CDK app for the cdk-real-drift TAG-addition mutation integration test (R95).
// The live guard for the R95 fix: a console-added tag must be DETECTED, not
// silently projected away. A tagged S3 bucket whose template declares one tag.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMutationTags");

const bucket = new Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });
Tags.of(bucket).add("team", "platform");

app.synth();

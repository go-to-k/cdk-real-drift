// CDK app for the cdk-real-drift `atDefault` integration test (R87).
//
// Two resources whose live state carries undeclared properties sitting at a known
// AWS default — exactly the values R86 folds into the `atDefault` tier:
//   - a default-config Lambda: TracingConfig=PassThrough, EphemeralStorage=512,
//     PackageType=Zip, RecursiveLoop=Terminate, RuntimeManagementConfig=Auto,
//     Architectures=[x86_64], MemorySize=128, Timeout=3 — none declared here.
//   - a bare L1 S3 bucket (NO Properties): the account-wide 2023 defaults AWS
//     applies — PublicAccessBlockConfiguration (all true), OwnershipControls
//     (BucketOwnerEnforced), BucketEncryption (SSE-S3 / AES256) — none declared.
//     This is the case that validates the hand-written KNOWN_DEFAULTS shapes
//     actually match what Cloud Control returns today (the R86 fragility risk).
import { App, CfnResource, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAtDefault");

new Function(stack, "DefaultFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  description: "cdk-real-drift atDefault integration test function",
});

// L1 bucket with NO Properties, so the template declares none of the security
// settings AWS applies by default — they read back live as undeclared-at-default.
new CfnResource(stack, "BareBucket", { type: "AWS::S3::Bucket" });

app.synth();

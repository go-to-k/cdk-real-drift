// Barest-config container-image Lambda fixture for the cdk-real-drift FP hunt.
// Every existing Lambda fixture/corpus case is PackageType: Zip; a container-image
// Lambda (PackageType: Image) has a DIFFERENT undeclared-default surface — no
// Runtime/Handler, but AWS materializes Architectures, EphemeralStorage,
// LoggingConfig, RuntimeManagementConfig, PackageType, and (crucially) an
// ImageConfigResponse — none of which this barest template declares. This probes
// whether those AWS-assigned defaults fold to atDefault on a first check (the
// #1477 "one-variant-covered" class). The image is built + pushed to a dedicated
// ECR repo out of band by verify.sh; its URI is passed via CDKRD_HUNT_IMAGE_URI.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnRole } from "aws-cdk-lib/aws-iam";

const imageUri = process.env.CDKRD_HUNT_IMAGE_URI;
if (!imageUri) throw new Error("CDKRD_HUNT_IMAGE_URI must be set (see verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntLambdaImg0713");

const role = new CfnRole(stack, "FnRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  },
  managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
});

// Barest image function: only what CFn requires for a container package —
// Code.ImageUri, PackageType, Role. No Architectures/EphemeralStorage/MemorySize/
// Timeout/LoggingConfig/ImageConfig declared, so all of those are undeclared and
// exercise the fold path for the Image variant.
new CfnFunction(stack, "Fn", {
  packageType: "Image",
  code: { imageUri },
  role: role.attrArn,
});

app.synth();

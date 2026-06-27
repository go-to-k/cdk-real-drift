// CDK app for the cdk-real-drift SageMaker Model false-positive / read-gap test.
// A SageMaker Model is metadata-only (no endpoint, no compute cost) yet common in
// ML CDK apps. Its CloudFormation physical id is the ModelName while the Cloud
// Control primaryIdentifier is ModelArn, so this also probes whether cdkrd can
// read it at all (a bare-name GetResource against an ARN-keyed type is a read-gap
// class). The container Environment map and the inference-pipeline Containers are
// exercised. A freshly deployed + recorded model with NO out-of-band change MUST
// report CLEAN (and MUST NOT come back silently skipped).
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnModel } from "aws-cdk-lib/aws-sagemaker";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSageMakerModel");

const role = new Role(stack, "ModelRole", {
  assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
});

// AWS-provided built-in algorithm images (us-east-1 account). CreateModel does not
// pull the image, so these only need to be well-formed ECR URIs.
const XGBOOST = "683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-xgboost:1.7-1";
const SKLEARN = "683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1";

new CfnModel(stack, "Model", {
  modelName: "cdkrd-sagemaker-model-rich",
  executionRoleArn: role.roleArn,
  inferenceExecutionConfig: { mode: "Serial" },
  containers: [
    {
      containerHostname: "preprocess",
      image: SKLEARN,
      mode: "SingleModel",
      environment: { ZETA: "1", ALPHA: "2", MIKE: "3" },
    },
    {
      containerHostname: "predict",
      image: XGBOOST,
      mode: "SingleModel",
      environment: { GAMMA: "x", DELTA: "y" },
    },
  ],
});

app.synth();

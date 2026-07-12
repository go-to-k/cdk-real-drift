// CDK app for the cdk-real-drift sagemaker-epc-min false-positive integration
// test. BAREST-possible SageMaker EndpointConfig — its SDK override reader has
// ZERO corpus cases and ZERO fixtures, so the barest first-run path
// (undeclared InitialVariantWeight and friends) has never been exercised live.
// The Model is metadata-only (no Endpoint is created, so nothing is billed and
// the container image is never pulled). The image URI is the us-east-1 AWS
// scikit-learn DLC, so this fixture is pinned to us-east-1.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnEndpointConfig, CfnModel } from "aws-cdk-lib/aws-sagemaker";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegSmEpcMin");

const role = new Role(stack, "HuntSmRole", {
  assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
});

const model = new CfnModel(stack, "HuntModel", {
  executionRoleArn: role.roleArn,
  primaryContainer: {
    image: "683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3",
  },
});

new CfnEndpointConfig(stack, "HuntEpc", {
  productionVariants: [
    {
      modelName: model.attrModelName,
      variantName: "AllTraffic",
      instanceType: "ml.t2.medium",
      initialInstanceCount: 1,
    },
  ],
});

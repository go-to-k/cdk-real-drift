// CDK app for the cdk-real-drift DOGFOOD (SageMaker domain): a SageMaker Model + an
// EndpointConfig (no running Endpoint, to avoid needing real model artifacts and to
// bound cost). Model is covered but EndpointConfig is an uncovered type; this checks
// the Model <-> EndpointConfig interaction reads + classifies clean via Cloud Control.
// A clean `record` -> `check` MUST be CLEAN; any declared drift is a default-folding FP.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnEndpointConfig, CfnModel } from 'aws-cdk-lib/aws-sagemaker';
import type { Construct } from 'constructs';

class DogfoodSageMakerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const role = new Role(this, 'ExecRole', {
      assumedBy: new ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')],
    });

    // A built-in inference image (XGBoost in us-east-1); Model creation is metadata-only
    // and does not require model artifacts (only a running Endpoint would).
    const model = new CfnModel(this, 'Model', {
      executionRoleArn: role.roleArn,
      primaryContainer: {
        image: '683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-xgboost:1.7-1',
        mode: 'SingleModel',
        environment: { SAGEMAKER_PROGRAM: 'inference.py' },
      },
    });

    new CfnEndpointConfig(this, 'EndpointConfig', {
      productionVariants: [
        {
          modelName: model.attrModelName,
          variantName: 'primary',
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
          initialVariantWeight: 1,
        },
      ],
    });
  }
}

const app = new App();
new DogfoodSageMakerStack(app, 'CdkRealDriftIntegDogfoodSageMaker', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

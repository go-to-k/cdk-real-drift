// CDK app for the cdk-real-drift SSM::Parameter Tier writeOnly-read-gap test.
//
// AWS::SSM::Parameter `Tier` is `writeOnlyProperties` — Cloud Control never echoes it,
// so an out-of-band tier change (Standard <-> Advanced, a real billing difference) was
// silently invisible. The SDK_SUPPLEMENTS reader now projects Tier from
// ssm:DescribeParameters; KNOWN_DEFAULTS folds an undeclared "Standard", and the
// INTELLIGENT_TIERING equivalence folds a declared "Intelligent-Tiering" against the
// Standard/Advanced tier AWS actually provisions.
//
// ParamStd declares Tier=Standard (the FN-test target). ParamIT declares
// Tier=Intelligent-Tiering (a small value, so AWS resolves it to Standard) — verify.sh
// proves that resolution does NOT false-flag.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { ParameterTier, StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

class SsmTierStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new StringParameter(this, 'ParamStd', {
      parameterName: '/cdkrd-integ/ssm-tier/std',
      stringValue: 'hello',
      tier: ParameterTier.STANDARD,
    });

    new StringParameter(this, 'ParamIT', {
      parameterName: '/cdkrd-integ/ssm-tier/it',
      stringValue: 'hello',
      tier: ParameterTier.INTELLIGENT_TIERING,
    });
  }
}

const app = new App();
new SsmTierStack(app, 'CdkRealDriftIntegSsmTierReadgap', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// CDK app for the cdk-real-drift SSM::Parameter writeOnly-read-gap integration test.
//
// AWS::SSM::Parameter `Description` (and `AllowedPattern`) are `writeOnlyProperties`
// in the CFn registry schema, so Cloud Control GetResource NEVER echoes them — an
// out-of-band console edit to the description was therefore SILENTLY invisible to
// cdkrd (it was stripped from both sides of the diff). The SDK_SUPPLEMENTS reader
// now lifts these two props from ssm:DescribeParameters and merges them onto the CC
// model so they are compared like any readable property.
//
// The stack DECLARES a Description + AllowedPattern. verify.sh proves:
//   1. clean record -> check is CLEAN (no false positive),
//   2. a console edit to the Description is DETECTED as declared drift (no false negative),
//   3. revert writes the declared Description back and check is CLEAN again.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

class SsmParameterDescStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new StringParameter(this, 'Param', {
      parameterName: '/cdkrd-integ/ssm-parameter-desc/value',
      stringValue: 'hello',
      description: 'declared description',
      allowedPattern: '^[a-z]+$',
    });
  }
}

const app = new App();
new SsmParameterDescStack(app, 'CdkRealDriftIntegSsmParameterDesc', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

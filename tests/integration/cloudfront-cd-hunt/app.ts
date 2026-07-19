// False-positive probe: CloudFront continuous deployment — a staging distribution
// (Staging: true), a ContinuousDeploymentPolicy (SingleWeight traffic split), and a
// primary distribution carrying ContinuousDeploymentPolicyId. Zero prior corpus or
// fixture coverage for AWS::CloudFront::ContinuousDeploymentPolicy or the staging
// distribution shape. L1 throughout so only the minimum is declared.
//
// TWO-PHASE: CloudFront REJECTS a ContinuousDeploymentPolicyId at distribution
// CREATION ("Continuous deployment policy is not supported during distribution
// creation") — the id can only be attached via an UPDATE. Deploy once without the
// context flag, then redeploy with `-c attach=1` to attach (which doubles as a
// post-update echo probe on the primary distribution).
import { App, Stack, Tags } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const app = new App();
Tags.of(app).add('cdkrd:ephemeral', '1');

const stack = new Stack(app, 'CdkrdHunt0720CfCd');

// Managed CachingDisabled policy id (stable AWS constant).
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

const baseConfig = {
  enabled: true,
  origins: [
    {
      id: 'origin1',
      domainName: 'example.com',
      customOriginConfig: {
        originProtocolPolicy: 'https-only',
      },
    },
  ],
  defaultCacheBehavior: {
    targetOriginId: 'origin1',
    viewerProtocolPolicy: 'allow-all',
    cachePolicyId: CACHING_DISABLED,
  },
};

const staging = new cloudfront.CfnDistribution(stack, 'StagingDist', {
  distributionConfig: {
    ...baseConfig,
    staging: true,
  },
});

const cdPolicy = new cloudfront.CfnContinuousDeploymentPolicy(stack, 'CdPolicy', {
  continuousDeploymentPolicyConfig: {
    enabled: true,
    stagingDistributionDnsNames: [staging.attrDomainName],
    trafficConfig: {
      type: 'SingleWeight',
      singleWeightConfig: { weight: 0.05 },
    },
  },
});

const attach = app.node.tryGetContext('attach') === '1';
new cloudfront.CfnDistribution(stack, 'PrimaryDist', {
  distributionConfig: {
    ...baseConfig,
    ...(attach ? { continuousDeploymentPolicyId: cdPolicy.attrId } : {}),
  },
});

app.synth();

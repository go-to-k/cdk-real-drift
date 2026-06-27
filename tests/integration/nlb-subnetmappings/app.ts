// CDK app for the cdk-real-drift ELBv2 LoadBalancer SubnetMappings set-reorder
// false-positive integration test. An internal NLB declares its `SubnetMappings`
// (an `insertionOrder:false` object array keyed by SubnetId — not in
// IDENTITY_FIELDS) NON-sorted (the second AZ's subnet first); if Cloud Control
// echoes the set reordered (e.g. by AZ/SubnetId), a freshly recorded clean stack
// false-positives as declared drift.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { CfnLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

class NlbSubnetMappingsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    const [s1, s2] = vpc.isolatedSubnets;

    new CfnLoadBalancer(this, 'Nlb', {
      type: 'network',
      scheme: 'internal',
      // SubnetMappings declared with the second subnet first (non-sorted by SubnetId).
      subnetMappings: [{ subnetId: s2.subnetId }, { subnetId: s1.subnetId }],
    });
  }
}

const app = new App();
new NlbSubnetMappingsStack(app, 'CdkRealDriftIntegNlbSubnetMappings', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

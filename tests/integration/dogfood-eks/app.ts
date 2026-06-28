// CDK app for the cdk-real-drift DOGFOOD (EKS domain): a bare EKS control plane — a
// VPC with two subnets, a cluster service role, and an AWS::EKS::Cluster (no managed
// node group, to bound cost/time). EKS is an entirely uncovered domain; this checks
// that a real cluster reads + classifies clean via Cloud Control. A clean `record` ->
// `check` MUST be CLEAN; any declared drift is a normalization / default-folding FP.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { CfnCluster } from 'aws-cdk-lib/aws-eks';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

class DogfoodEksStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const role = new Role(this, 'ClusterRole', {
      assumedBy: new ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy')],
    });

    new CfnCluster(this, 'Cluster', {
      name: `${id}-cluster`,
      roleArn: role.roleArn,
      version: '1.31',
      resourcesVpcConfig: {
        subnetIds: vpc.publicSubnets.map((s) => s.subnetId),
        endpointPublicAccess: true,
        endpointPrivateAccess: false,
      },
    });
  }
}

const app = new App();
new DogfoodEksStack(app, 'CdkRealDriftIntegDogfoodEks', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

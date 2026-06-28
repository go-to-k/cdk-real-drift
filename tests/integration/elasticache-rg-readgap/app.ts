// CDK app for the cdk-real-drift ElastiCache ReplicationGroup writeOnly-read-gap test.
//
// On AWS::ElastiCache::ReplicationGroup `PreferredMaintenanceWindow`,
// `NotificationTopicArn` and `EngineVersion` are `writeOnlyProperties` — Cloud Control
// echoes the RG's other props but NEVER these three (they live on the member cache
// clusters), so an out-of-band change to the maintenance window or the notification
// topic was silently invisible to cdkrd. The SDK_SUPPLEMENTS reader fetches them
// verbatim from the member cache cluster via DescribeCacheClusters.
//
// The RG declares all three (EngineVersion "7.1" exercises the prefix fold).
// verify.sh proves clean record -> check is CLEAN, an out-of-band maintenance-window
// change is DETECTED, and revert restores it.
import { App, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Vpc, SubnetType, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { CfnReplicationGroup, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

class ElastiCacheRgStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Minimal isolated VPC (no NAT) — ElastiCache only needs subnets in 1+ AZ.
    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    const sg = new SecurityGroup(this, 'Sg', { vpc });
    const topic = new Topic(this, 'EventTopic');

    const subnetGroup = new CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'cdkrd integ',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    const rg = new CfnReplicationGroup(this, 'Rg', {
      replicationGroupDescription: 'cdkrd integ',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      multiAzEnabled: false,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [sg.securityGroupId],
      // A fixed snapshot window so the maintenance-window mutation in verify.sh can
      // pick a non-overlapping target deterministically (ElastiCache rejects an
      // overlapping pair).
      snapshotWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      notificationTopicArn: topic.topicArn,
    });
    rg.addDependency(subnetGroup);
    rg.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}

const app = new App();
new ElastiCacheRgStack(app, 'CdkRealDriftIntegElastiCacheRgReadgap', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

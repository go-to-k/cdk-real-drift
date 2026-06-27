// CDK app for the cdk-real-drift ElastiCache CacheCluster set-reorder
// false-positive integration test. It probes whether AWS reorders the
// `LogDeliveryConfigurations` set (an `insertionOrder:false` object array keyed
// by LogType — not in IDENTITY_FIELDS) when Cloud Control reads it back. The two
// configs are declared NON-sorted by LogType (slow-log before engine-log); if
// AWS canonicalizes (sorts) the set, a freshly recorded clean stack
// false-positives as declared drift.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

class ElastiCacheLogDeliveryStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });

    const subnetGroup = new CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'cdkrd integ subnet group',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    const sg = new SecurityGroup(this, 'Sg', {
      vpc,
      description: 'cdkrd integ cache sg',
    });

    const slowLog = new LogGroup(this, 'SlowLog', {
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const engineLog = new LogGroup(this, 'EngineLog', {
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnCacheCluster(this, 'Cache', {
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      engineVersion: '7.1',
      cacheSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      // LogDeliveryConfigurations declared slow-log before engine-log (non-sorted
      // by LogType; alphabetical would be engine-log first).
      logDeliveryConfigurations: [
        {
          logType: 'slow-log',
          logFormat: 'json',
          destinationType: 'cloudwatch-logs',
          destinationDetails: {
            cloudWatchLogsDetails: { logGroup: slowLog.logGroupName },
          },
        },
        {
          logType: 'engine-log',
          logFormat: 'json',
          destinationType: 'cloudwatch-logs',
          destinationDetails: {
            cloudWatchLogsDetails: { logGroup: engineLog.logGroupName },
          },
        },
      ],
    });
  }
}

const app = new App();
new ElastiCacheLogDeliveryStack(app, 'CdkRealDriftIntegElastiCacheLogDelivery', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

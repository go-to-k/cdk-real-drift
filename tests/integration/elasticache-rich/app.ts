// CDK app for the cdk-real-drift ElastiCache Redis ReplicationGroup test.
// ElastiCache is a common managed-cache choice and a "slow stateful" resource:
// the ReplicationGroup carries many server-default-filled knobs (Port,
// SnapshotRetentionLimit, AutoMinorVersionUpgrade, SnapshotWindow,
// PreferredMaintenanceWindow, encryption flags) plus a VPC + cache subnet group
// + security group. It is deliberately run as its own round (VPC-dependent,
// multi-minute deploy/teardown). A freshly deployed + recorded replication group
// with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnReplicationGroup, CfnSubnetGroup } from "aws-cdk-lib/aws-elasticache";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElastiCacheRich");

// No NAT, isolated subnets only — ElastiCache needs no internet egress, and this
// keeps the deploy fast and cheap.
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

const sg = new SecurityGroup(stack, "Sg", { vpc, allowAllOutbound: true });

const subnetGroup = new CfnSubnetGroup(stack, "SubnetGroup", {
  description: "cdkrd elasticache subnet group",
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
  cacheSubnetGroupName: "cdkrd-elasticache-rich",
});

const rg = new CfnReplicationGroup(stack, "ReplicationGroup", {
  replicationGroupId: "cdkrd-ec-rich",
  replicationGroupDescription: "cdkrd elasticache rich",
  engine: "redis",
  cacheNodeType: "cache.t3.micro",
  numCacheClusters: 1,
  automaticFailoverEnabled: false,
  cacheSubnetGroupName: "cdkrd-elasticache-rich",
  securityGroupIds: [sg.securityGroupId],
  atRestEncryptionEnabled: true,
  transitEncryptionEnabled: true,
  snapshotRetentionLimit: 1,
  port: 6379,
});
rg.addDependency(subnetGroup);
rg.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

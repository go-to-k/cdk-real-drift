// CDK app for the cdk-real-drift elasticache-memcached false-positive integ test.
// Every existing ElastiCache CacheCluster corpus case is a REDIS cluster; Memcached is
// the other everyday ElastiCache engine and is entirely uncovered. Memcached reports a
// few engine-specific shapes Redis does not (e.g. ConfigurationEndpoint, a multi-node
// AZ mode), so its live model is a distinct normalize/classify input worth pinning.
// This also settles the VERSION_PREFIX question across engines: ElastiCache's CC-native
// read echoes the stored EngineVersion verbatim (redis "7.1" -> "7.1", proven), and
// Memcached is specified with a FULL version ("1.6.22"), so there is no partial->concrete
// resolution for a standalone CacheCluster (unlike the ReplicationGroup, whose writeOnly
// EngineVersion is supplied by an SDK_SUPPLEMENTS reader). A freshly recorded cluster
// MUST check CLEAN. A single cache.t3.micro Memcached node on an isolated VPC is cheap.
import { App, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCacheCluster, CfnSubnetGroup } from "aws-cdk-lib/aws-elasticache";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElasticacheMemcached");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [{ name: "priv", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc });

const subnetGroup = new CfnSubnetGroup(stack, "SubnetGroup", {
  description: "cdkrd integ memcached subnet group",
  subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
});

const cluster = new CfnCacheCluster(stack, "Cache", {
  engine: "memcached",
  cacheNodeType: "cache.t3.micro",
  numCacheNodes: 1,
  engineVersion: "1.6.22",
  azMode: "single-az",
  cacheSubnetGroupName: subnetGroup.ref,
  vpcSecurityGroupIds: [sg.securityGroupId],
  port: 11211,
});
cluster.addDependency(subnetGroup);

app.synth();

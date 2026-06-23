// CDK app for the cdk-real-drift elasticache-cachecluster-rich integration test.
// AWS::ElastiCache::CacheCluster is the everyday single-node Redis/Memcached cache
// primitive. The ElastiCache family covers ReplicationGroup / ServerlessCache /
// ParameterGroup / SubnetGroup but NOT CacheCluster — a direct coverage gap. It is
// FULLY_MUTABLE with a single-segment CC primaryIdentifier (ClusterName), so it
// reads cleanly. Its `EngineVersion` is declared as a partial track (`"7.1"`) that
// the service may resolve to a concrete patch (`"7.1.0"`) — a partial->concrete
// VERSION_PREFIX false-positive probe (RDS/Aurora/Neptune already fold this; whether
// ElastiCache needs the same fold is the open question). A freshly recorded cluster
// MUST check CLEAN. A single cache.t3.micro Redis node on an isolated VPC is cheap.
import { App, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCacheCluster, CfnSubnetGroup } from "aws-cdk-lib/aws-elasticache";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElasticacheCacheclusterRich");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [{ name: "priv", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc });

const subnetGroup = new CfnSubnetGroup(stack, "SubnetGroup", {
  description: "cdkrd integ cache subnet group",
  subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
});

const cluster = new CfnCacheCluster(stack, "Cache", {
  engine: "redis",
  cacheNodeType: "cache.t3.micro",
  numCacheNodes: 1,
  // Partial version track — the VERSION_PREFIX false-positive probe.
  engineVersion: "7.1",
  cacheSubnetGroupName: subnetGroup.ref,
  vpcSecurityGroupIds: [sg.securityGroupId],
  port: 6379,
});
cluster.addDependency(subnetGroup);

app.synth();

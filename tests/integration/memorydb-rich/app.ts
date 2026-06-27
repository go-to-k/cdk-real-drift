// CDK app for the cdk-real-drift MemoryDB false-positive test. MemoryDB (managed
// Redis/Valkey) is a common cache backend. This exercises a single-node cluster in
// an isolated VPC with TWO security groups declared in a deliberately non-sorted
// order (SecurityGroupIds is a set AWS may echo reordered) and a partial
// EngineVersion (a version-prefix FP probe: does CC echo "7.1" verbatim like
// ElastiCache, or expand it?). A freshly deployed + recorded cluster with NO
// out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnSubnetGroup } from "aws-cdk-lib/aws-memorydb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMemoryDb");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED }],
});

const sgA = new SecurityGroup(stack, "SgA", { vpc, allowAllOutbound: true });
const sgB = new SecurityGroup(stack, "SgB", { vpc, allowAllOutbound: true });

const subnetGroup = new CfnSubnetGroup(stack, "SubnetGroup", {
  subnetGroupName: "cdkrd-memorydb-sng",
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
});

const cluster = new CfnCluster(stack, "Cluster", {
  clusterName: "cdkrd-memorydb-rich",
  nodeType: "db.t4g.small",
  aclName: "open-access",
  engine: "redis",
  engineVersion: "7.1",
  numShards: 1,
  numReplicasPerShard: 0,
  tlsEnabled: true,
  subnetGroupName: subnetGroup.ref,
  // declared deliberately non-sorted to expose a SecurityGroupIds set-reorder FP
  securityGroupIds: [sgB.securityGroupId, sgA.securityGroupId],
  snapshotRetentionLimit: 1,
});
cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

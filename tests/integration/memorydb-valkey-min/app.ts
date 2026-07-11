// CDK app for the cdk-real-drift memorydb-valkey-min false-positive
// integration test. BAREST-possible VALKEY MemoryDB cluster — every MemoryDB
// fold was live-confirmed on engine=redis only (corpus: redis 7.1); the valkey
// branch (engine echo, valkey default parameter group name `default.valkey8`,
// EngineVersion GA fill, ACL/TLS defaults) has never run live. SubnetGroup is
// required by the API; NodeType/ACLName declared as the minimum viable config.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnSubnetGroup } from "aws-cdk-lib/aws-memorydb";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegMemoryDbValkeyMin");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED }],
});

const subnetGroup = new CfnSubnetGroup(stack, "HuntSubnetGroup", {
  subnetGroupName: "cdkrd-hunt-mdb-valkey-sng",
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
});

new CfnCluster(stack, "HuntValkeyCluster", {
  clusterName: "cdkrd-hunt-mdb-valkey",
  nodeType: "db.t4g.small",
  aclName: "open-access",
  engine: "valkey",
  subnetGroupName: subnetGroup.ref,
});

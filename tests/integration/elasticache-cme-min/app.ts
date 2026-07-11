// CDK app for the cdk-real-drift elasticache-cme-min false-positive
// integration test. BAREST-possible CLUSTER-MODE-ENABLED redis
// ReplicationGroup — the KNOWN_DEFAULTS entry pins ClusterMode:'disabled' and
// every corpus RG is cluster-mode-disabled, so the enabled branch (ClusterMode
// echo, default.redis7.cluster.on parameter group fill, NodeGroupConfiguration
// echoes) has never run live. NumNodeGroups=2 + 0 replicas is the smallest
// cluster-mode shape; CacheNodeType declared only to control cost.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnReplicationGroup } from "aws-cdk-lib/aws-elasticache";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegElastiCacheCmeMin");

new CfnReplicationGroup(stack, "HuntCmeRg", {
  replicationGroupDescription: "cdkrd hunt minimal cluster-mode-enabled rg",
  engine: "redis",
  cacheNodeType: "cache.t4g.micro",
  numNodeGroups: 2,
  replicasPerNodeGroup: 0,
});

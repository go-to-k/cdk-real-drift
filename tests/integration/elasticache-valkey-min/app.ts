// CDK app for the cdk-real-drift elasticache-valkey-min false-positive
// integration test. BAREST-possible VALKEY ReplicationGroup — the
// ENGINE_DEFAULTS valkey arm (#818: AtRestEncryptionEnabled=true) was added
// from docs/API knowledge but no valkey RG ever ran live, and valkey-specific
// echoes (default parameter group name, TransitEncryption* defaults,
// EngineVersion GA fill) are unverified. Runs in the default VPC (no subnet
// group declared → probes the `default` CacheSubnetGroupName echo).
// CacheNodeType is declared only to control cost.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnReplicationGroup } from "aws-cdk-lib/aws-elasticache";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegElastiCacheValkeyMin");

new CfnReplicationGroup(stack, "HuntValkeyRg", {
  replicationGroupDescription: "cdkrd hunt minimal valkey replication group",
  engine: "valkey",
  cacheNodeType: "cache.t4g.micro",
  numCacheClusters: 1,
  // valkey RGs default AutomaticFailoverEnabled to TRUE (unlike redis — a live-observed
  // engine-axis difference), which rejects a single-node group; declare it off to keep
  // the fixture single-node. TransitEncryptionEnabled has NO default for valkey (the API
  // demands an explicit value — another engine-axis difference), so it must be declared.
  automaticFailoverEnabled: false,
  transitEncryptionEnabled: false,
});

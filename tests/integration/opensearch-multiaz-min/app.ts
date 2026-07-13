// CDK app for the cdk-real-drift opensearch-multiaz-min false-positive
// integration test. A MINIMAL zone-aware (Multi-AZ) OpenSearch domain — both
// existing corpus domains are single-AZ (ZoneAwareness=false, no dedicated
// master), so the ClusterConfig default cascade that Multi-AZ materializes
// (ZoneAwarenessConfig.AvailabilityZoneCount, per-AZ distribution echoes) is
// unexercised. Declares only the zone-awareness axis + the minimal capacity it
// requires (2 data nodes); everything else (EngineVersion, EBS defaults,
// software update options, ...) stays undeclared to probe the folds.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnDomain } from "aws-cdk-lib/aws-opensearchservice";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714OsMultiAz");

const domain = new CfnDomain(stack, "HuntOsMultiAz", {
  clusterConfig: {
    instanceType: "t3.small.search",
    instanceCount: 2,
    zoneAwarenessEnabled: true,
  },
  ebsOptions: {
    ebsEnabled: true,
    volumeSize: 10,
  },
});
domain.applyRemovalPolicy(RemovalPolicy.DESTROY);

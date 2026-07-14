// CDK app for the cdk-real-drift os-variants2-min false-positive integration test.
// The two OpenSearchService Domain variant axes still un-deployed after
// opensearch-multiaz-min (#1593):
//   - DEDICATED MASTER: DedicatedMasterEnabled=true with count/type UNDECLARED —
//     probes the materialized master defaults (documented count default 3; the
//     type echo is the open question).
//   - LEGACY ELASTICSEARCH ENGINE: EngineVersion=Elasticsearch_7.10 (declared to
//     select the axis; still creatable) — probes ES-era default echoes
//     (AdvancedOptions, endpoint options) against folds live-proven on
//     OpenSearch_* engines only.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnDomain } from "aws-cdk-lib/aws-opensearchservice";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714OsVariants2");

const dedMaster = new CfnDomain(stack, "HuntOsDedMaster", {
  clusterConfig: {
    instanceType: "t3.small.search",
    instanceCount: 2,
    zoneAwarenessEnabled: true,
    dedicatedMasterEnabled: true,
    dedicatedMasterType: "t3.small.search",
  },
  ebsOptions: {
    ebsEnabled: true,
    volumeSize: 10,
  },
});
dedMaster.applyRemovalPolicy(RemovalPolicy.DESTROY);

const esLegacy = new CfnDomain(stack, "HuntEsLegacy", {
  engineVersion: "Elasticsearch_7.10",
  clusterConfig: {
    instanceType: "t3.small.search",
    instanceCount: 1,
  },
  ebsOptions: {
    ebsEnabled: true,
    volumeSize: 10,
  },
});
esLegacy.applyRemovalPolicy(RemovalPolicy.DESTROY);

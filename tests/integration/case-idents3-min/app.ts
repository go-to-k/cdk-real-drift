// CDK app for the cdk-real-drift case-idents3-min false-positive integration test.
// Mixed-case identifier echo probe #3 — AWS::Redshift::Cluster ClusterIdentifier,
// the sibling CASE_INSENSITIVE_PATHS explicitly defers in noise.ts ("CDK-lowered
// already and unprobed — add it here only with live proof"). Redshift stores
// cluster identifiers lowercase; its ClusterParameterGroup handler passed mixed
// case through and FP'd (#1531). If the Cluster handler also passes it through,
// the declared value echoes back lowercased -> declared-tier FP. A handler-side
// rejection is itself the determination (no allowlist entry needed).
// Live determinations (2026-07-14, Cloud Control create-resource probes — the
// CC handler IS the CFn handler): AWS::MemoryDB::SubnetGroup / User / ACL all
// REJECT a mixed-case name server-side ("must contain only lowercase ASCII
// letters...") — unreachable via CloudFormation, so no FP risk and no
// CASE_INSENSITIVE_PATHS entries needed (completes the MemoryDB family begun
// by the ParameterGroup determination in case-idents2-min).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnCluster } from "aws-cdk-lib/aws-redshift";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714CaseIdents3");

new CfnCluster(stack, "HuntRsCluster", {
  clusterIdentifier: "CdkrdHunt-Mixed-RsCluster",
  clusterType: "single-node",
  nodeType: "ra3.large",
  dbName: "huntdb",
  masterUsername: "huntadmin",
  masterUserPassword: "CdkrdHuntPassw0rd1",
});

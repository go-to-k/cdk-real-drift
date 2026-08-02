// CDK app for the cdk-real-drift aurora-mysql-min false-positive integration
// test. BAREST-possible aurora-mysql DBCluster (no instances — the cluster
// alone reaches `available`): only Engine + master credentials declared.
// The aurora-mysql arm of the RDS fold tables was built from a RICH
// aurora-mysql corpus only (aurora-rich declares most properties), so any
// aurora-mysql default that only materializes when the property is UNDECLARED
// was never exercised — the mirror of aurora-pg-min on the other engine arm
// (2026-08-02 hunt, variant-audit finding).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDBCluster } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegAuroraMysqlMin");

new CfnDBCluster(stack, "HuntAuroraMysql", {
  engine: "aurora-mysql",
  masterUsername: "huntadmin",
  masterUserPassword: "cdkrdHuntPassw0rd1",
});

app.synth();

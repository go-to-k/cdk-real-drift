// CDK app for the cdk-real-drift aurora-pg-min false-positive integration
// test. BAREST-possible aurora-postgresql DBCluster (no instances — the
// cluster alone reaches `available`): only Engine + master credentials
// declared. The existing RDS fold tables were built from an aurora-mysql +
// provisioned-mysql corpus (#1477 fixed the provisioned gap); the
// aurora-postgresql arm (Port 5432 engine default, PG-specific echoes,
// parameter-group family) has never run live.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDBCluster } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegAuroraPgMin");

new CfnDBCluster(stack, "HuntAuroraPg", {
  engine: "aurora-postgresql",
  masterUsername: "huntadmin",
  masterUserPassword: "cdkrdHuntPassw0rd1",
});

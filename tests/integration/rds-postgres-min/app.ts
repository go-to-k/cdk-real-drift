// CDK app for the cdk-real-drift rds-postgres-min false-positive integration
// test. BAREST-possible provisioned postgres DBInstance (the #1477 class, next
// engine axis branch): only Engine / DBInstanceClass / AllocatedStorage /
// master credentials declared. ENGINE_DEFAULTS' postgres arm (Port 5432,
// LicenseModel postgresql-license) has never been exercised by a live deploy.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegRdsPostgresMin");

new CfnDBInstance(stack, "HuntPostgres", {
  engine: "postgres",
  dbInstanceClass: "db.t3.micro",
  allocatedStorage: "20",
  masterUsername: "huntadmin",
  masterUserPassword: "cdkrdHuntPassw0rd1",
});

// CDK app for the cdk-real-drift rds-sqlserver-min false-positive integration
// test. BAREST-possible sqlserver-ex DBInstance — the highest-risk un-deployed
// engine branch: ENGINE_DEFAULTS deliberately leaves LicenseModel undefined
// for sqlserver (so an undeclared LicenseModel is expected to first-run FP
// today), and the sqlserver-specific echoes (CharacterSetName etc.) are
// unknown. Only Engine / DBInstanceClass / AllocatedStorage / master
// credentials declared.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegRdsSqlServerMin");

new CfnDBInstance(stack, "HuntSqlServer", {
  engine: "sqlserver-ex",
  dbInstanceClass: "db.t3.micro",
  allocatedStorage: "20",
  masterUsername: "huntadmin",
  masterUserPassword: "cdkrdHuntPassw0rd1",
});

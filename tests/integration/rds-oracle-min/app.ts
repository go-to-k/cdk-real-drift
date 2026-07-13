// CDK app for the cdk-real-drift rds-oracle-min false-positive integration test.
// BAREST-possible provisioned DBInstance on the ONE engine family with zero
// corpus/fixture coverage: oracle (oracle-se2). The ENGINE_DEFAULTS folds in
// noise.ts were live-confirmed on mysql/mariadb/postgres/sqlserver only —
// oracle-specific defaults (CharacterSetName AL32UTF8 + NcharCharacterSetName,
// Port 1521, StorageType, default:oracle-se2-19 option/parameter groups,
// undeclared EngineVersion) ride unverified branches (#1477 proved a variant
// you did not deploy is an unguarded gap). L1 CfnDBInstance so EngineVersion /
// StorageType / CharacterSetName / group names all stay UNDECLARED (the L2
// forces a version). LicenseModel IS declared: the Oracle API default is
// bring-your-own-license, which this account neither holds nor wants to probe.
// Uses the default VPC (no DBSubnetGroup) — the barest possible shape.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714RdsOracle");

new CfnDBInstance(stack, "HuntOracle", {
  engine: "oracle-se2",
  dbInstanceClass: "db.t3.small",
  allocatedStorage: "20",
  licenseModel: "license-included",
  masterUsername: "huntadmin",
  masterUserPassword: "CdkrdHuntPassw0rd1",
});

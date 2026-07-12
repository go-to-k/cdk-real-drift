// CDK app for the cdk-real-drift rds-mariadb-min false-positive integration test.
// BAREST-possible non-Aurora provisioned DBInstance on the ONE engine with zero
// corpus coverage: mariadb (#1477 proved the folds were Aurora/postgres/mysql/
// sqlserver-derived; a variant you did not deploy is an unguarded gap). Declares
// only what CFn requires — engine / class / storage / creds — so the MOST
// properties ride the undeclared-default folds. Doubles as the round-3 revert-
// convergence probe for the ModifyDBInstance omitted-property family
// (BackupRetentionPeriod / CopyTagsToSnapshot).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, SecretValue, Stack, Tags } from "aws-cdk-lib";
import { InstanceClass, InstanceSize, InstanceType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, MariaDbEngineVersion } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713RdsMariadb");

const vpc = new Vpc(stack, "HuntVpc", {
  maxAzs: 2,
  natGateways: 0,
});

new DatabaseInstance(stack, "HuntMariaDb", {
  engine: DatabaseInstanceEngine.mariaDb({ version: MariaDbEngineVersion.VER_11_4 }),
  instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  credentials: Credentials.fromPassword("huntadmin", SecretValue.unsafePlainText("CdkrdHuntPassw0rd!")),
  removalPolicy: RemovalPolicy.DESTROY,
  deleteAutomatedBackups: true,
});

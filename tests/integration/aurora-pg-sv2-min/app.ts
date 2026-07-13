// CDK app for the cdk-real-drift aurora-pg-sv2-min false-positive integration
// test. Aurora POSTGRESQL + ServerlessV2 — the corpus covers Sv2 scaling only on
// aurora-mysql and aurora-postgresql only as provisioned, so the combination
// (pg-specific default parameter/option groups + Sv2 capacity echoes on the
// cluster, plus a db.serverless instance) is unexercised. Minimal: engine +
// Sv2 scaling + one serverless instance; version / groups / storage stay
// undeclared to probe the folds.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, SecretValue, Stack, Tags } from "aws-cdk-lib";
import { InstanceType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714AuroraPgSv2");

const vpc = new Vpc(stack, "HuntVpc", {
  maxAzs: 2,
  natGateways: 0,
});

new DatabaseCluster(stack, "HuntAuroraPgSv2", {
  engine: DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_16_4 }),
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  credentials: Credentials.fromPassword("huntadmin", SecretValue.unsafePlainText("CdkrdHuntPassw0rd1")),
  serverlessV2MinCapacity: 0.5,
  serverlessV2MaxCapacity: 1,
  writer: ClusterInstance.serverlessV2("writer"),
  removalPolicy: RemovalPolicy.DESTROY,
});

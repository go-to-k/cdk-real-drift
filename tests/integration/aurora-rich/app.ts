// CDK app for the cdk-real-drift aurora-rich false-positive + detect integration test.
// Amazon Aurora (AWS::RDS::DBCluster + ::DBInstance, read NATIVELY via Cloud Control)
// is the user-flagged "scary" surface: REPLICATION (a reader instance) + custom
// PARAMETER GROUPS (cluster + instance) + version-track resolution all fold into AWS's
// live model. A clean record->check is a strong false-positive oracle for exactly
// those features; the cluster's BackupRetentionPeriod is the declared MUTABLE
// detect/revert subject. A small isolated VPC (no NAT) keeps the stack self-contained.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { InstanceClass, InstanceSize, InstanceType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  AuroraMysqlEngineVersion,
  ClusterInstance,
  DatabaseClusterEngine,
  DatabaseCluster,
  ParameterGroup,
} from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAuroraRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

// Pin the engine version via the escape hatch — the named CDK enum const was
// "version not available" in-region (verified via describe-db-engine-versions).
const engine = DatabaseClusterEngine.auroraMysql({
  version: AuroraMysqlEngineVersion.of("8.0.mysql_aurora.3.10.4", "8.0"),
});

const clusterPg = new ParameterGroup(stack, "ClusterPg", {
  engine,
  parameters: { character_set_server: "utf8mb4" },
});
const instancePg = new ParameterGroup(stack, "InstancePg", {
  engine,
  parameters: { general_log: "1" },
});
const instanceType = InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM);

new DatabaseCluster(stack, "Cluster", {
  engine,
  writer: ClusterInstance.provisioned("writer", { instanceType, parameterGroup: instancePg }),
  readers: [ClusterInstance.provisioned("reader", { instanceType, parameterGroup: instancePg })],
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  parameterGroup: clusterPg,
  backup: { retention: Duration.days(3) },
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

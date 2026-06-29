// CDK app for the cdk-real-drift Aurora Serverless v2 false-positive integration test.
// Aurora Serverless v2 (post-2023) is now a daily-driver RDS shape the corpus did not
// cover. It declares normalization-prone properties whose live AWS form may differ:
//   - ServerlessV2ScalingConfiguration { MinCapacity, MaxCapacity } — a nested object
//     AWS may enrich (e.g. SecondsUntilAutoPause default) or fold.
//   - EngineVersion declared partial ("8.0.mysql_aurora.3.08.x"-style) vs the concrete
//     value AWS reads back (VERSION_PREFIX_PATHS territory).
//   - EnableCloudwatchLogsExports (an unordered set) + a custom DB cluster parameter
//     group. The two serverless-v2 instances (writer + reader) round-trip too.
// A freshly deployed + recorded cluster with NO out-of-band change MUST report CLEAN.
// NAT-free isolated subnets keep cost down; removalPolicy DESTROY + no deletion
// protection keep teardown clean.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  AuroraMysqlEngineVersion,
  ClusterInstance,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAuroraSv2");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

new DatabaseCluster(stack, "Cluster", {
  engine: DatabaseClusterEngine.auroraMysql({ version: AuroraMysqlEngineVersion.VER_3_08_0 }),
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  serverlessV2MinCapacity: 0.5,
  serverlessV2MaxCapacity: 2,
  writer: ClusterInstance.serverlessV2("writer"),
  readers: [ClusterInstance.serverlessV2("reader", { scaleWithWriter: true })],
  enableDataApi: true,
  cloudwatchLogsExports: ["audit", "error", "general", "slowquery"],
  backup: { retention: Duration.days(7) },
  removalPolicy: RemovalPolicy.DESTROY,
  deletionProtection: false,
});

app.synth();

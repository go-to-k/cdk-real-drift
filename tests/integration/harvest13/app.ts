// cdk-real-drift corpus-harvest wave 13 (real AWS) — R130.
// Slow / config-dense DATA-PLANE uncovered types — the best remaining FP targets
// because they carry the most live config:
//   RDS DBInstance (mysql 8.0, db.t3.micro, single-AZ, self-cleaning),
//   ElastiCache ServerlessCache (valkey),
//   OpenSearchService Domain (smallest possible: t3.small.search single node, gp3 EBS).
// Each carries a few NON-default declared properties. Everything self-cleans
// (removalPolicy DESTROY, deleteAutomatedBackups, no final snapshot).
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  EbsDeviceVolumeType,
  InstanceClass,
  InstanceSize,
  InstanceType,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { CfnServerlessCache } from "aws-cdk-lib/aws-elasticache";
import {
  Domain,
  EngineVersion,
} from "aws-cdk-lib/aws-opensearchservice";
import {
  DatabaseInstance,
  DatabaseInstanceEngine,
  MysqlEngineVersion,
} from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest13");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
  ],
});
const subnetIds = vpc.publicSubnets.map((s) => s.subnetId);

const cacheSg = new SecurityGroup(stack, "CacheSg", {
  vpc,
  description: "cdkrd harvest serverless cache sg",
  allowAllOutbound: true,
});

// --- RDS DBInstance (mysql 8.0, db.t3.micro, single-AZ; self-cleaning) ---
new DatabaseInstance(stack, "Database", {
  engine: DatabaseInstanceEngine.mysql({
    version: MysqlEngineVersion.VER_8_0,
  }),
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  vpc,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  allocatedStorage: 20,
  multiAz: false,
  // non-default declared props:
  backupRetention: Duration.days(3),
  storageEncrypted: true,
  deletionProtection: false,
  deleteAutomatedBackups: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

// --- ElastiCache ServerlessCache (valkey; config-dense) ---
new CfnServerlessCache(stack, "ServerlessCache", {
  engine: "valkey",
  serverlessCacheName: "cdkrd-h13-cache",
  description: "cdkrd harvest serverless cache",
  majorEngineVersion: "8",
  subnetIds,
  securityGroupIds: [cacheSg.securityGroupId],
});

// --- OpenSearchService Domain (smallest possible; very config-dense) ---
new Domain(stack, "OpenSearch", {
  version: EngineVersion.OPENSEARCH_2_11,
  capacity: {
    dataNodes: 1,
    dataNodeInstanceType: "t3.small.search",
    multiAzWithStandbyEnabled: false,
  },
  ebs: {
    enabled: true,
    volumeSize: 10,
    volumeType: EbsDeviceVolumeType.GP3,
  },
  zoneAwareness: { enabled: false },
  // non-default declared props:
  enforceHttps: true,
  nodeToNodeEncryption: true,
  encryptionAtRest: { enabled: true },
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

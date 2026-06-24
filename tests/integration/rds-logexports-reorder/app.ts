// CDK app for the cdk-real-drift rds-logexports-reorder integration test.
//
// The scalar-enum set-reorder vein, RDS edition. RDS DBInstance's
// EnableCloudwatchLogsExports is a SET of log-type enums (error/general/slowquery/
// audit for MySQL) that a huge fraction of RDS users declare. If RDS echoes the set in
// its own canonical order (e.g. alphabetical), a positional compare false-drifts the
// identical log-type set on every check — exactly the class of the ECS
// RequiresCompatibilities (#365) / CodeDeploy Events (#364) FPs, on one of the most
// common stateful resources. The log-type tokens are not ids/ARNs/AZ/HTTP, so the
// generic canonicalizeIdArraysDeep leaves them untouched; only a per-type
// UNORDERED_ARRAY_PROPS entry would guard them.
//
// Declared NON-sorted (slowquery, general, error) — a sorted declaration would hide a
// reorder. A minimal isolated-subnet VPC (no NAT) + a db.t3.micro single-AZ instance
// keeps cost low; the instance is the only slow part (~6-10 min create).
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { InstanceClass, InstanceSize, InstanceType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  MysqlEngineVersion,
} from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRdsLogexportsReorder");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

new DatabaseInstance(stack, "Db", {
  engine: DatabaseInstanceEngine.mysql({
    version: MysqlEngineVersion.VER_8_0,
  }),
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  credentials: Credentials.fromGeneratedSecret("cdkrdadmin"),
  allocatedStorage: 20,
  multiAz: false,
  backupRetention: Duration.days(0), // disable automated backups (faster delete, no snapshot)
  deleteAutomatedBackups: true,
  deletionProtection: false,
  removalPolicy: RemovalPolicy.DESTROY,
  // a scalar enum SET declared NON-sorted (alphabetical = error, general, slowquery)
  cloudwatchLogsExports: ["slowquery", "general", "error"],
});

app.synth();

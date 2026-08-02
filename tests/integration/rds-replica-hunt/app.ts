// CDK app for the cdk-real-drift rds-replica-hunt integration test (2026-08-02
// hunt). Two live probes in one stack:
//   1. #1704's derived replica defaults vs REVERT: a read replica's undeclared
//      BackupRetentionPeriod folds to the DERIVED 0, but the RSDP revert route
//      sources the STATIC KNOWN_DEFAULTS 1 — an out-of-band BRP change on the
//      replica must revert back to 0, not 1 (verify-detect.sh asserts the live
//      value).
//   2. The mixed-case REFERENCING-property FP family: RDS stores group names
//      LOWERCASED, so a raw-CFn consumer that references a mixed-case name
//      (DBParameterGroupName / DBSubnetGroupName here) reads back the lowercase
//      echo — a permanent declared FP until the reference props join the
//      case-insensitive fold (the owning types' Name props were already listed).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnDBInstance, CfnDBParameterGroup, CfnDBSubnetGroup } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegRdsReplicaHunt");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "db", subnetType: SubnetType.PRIVATE_ISOLATED }],
});

const pg = new CfnDBParameterGroup(stack, "MixedPg", {
  dbParameterGroupName: "CdkrdHunt-Mixed-DPG",
  // The CURRENT default mysql major (8.4 as of 2026-08) — RDS rejects an instance
  // whose undeclared EngineVersion resolves to a different family than its PG.
  family: "mysql8.4",
  description: "cdkrd hunt mixed-case parameter group",
});

const sng = new CfnDBSubnetGroup(stack, "MixedSng", {
  dbSubnetGroupName: "CdkrdHunt-Mixed-SNG",
  dbSubnetGroupDescription: "cdkrd hunt mixed-case subnet group",
  subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
});

// The MIXED-CASE literals (not Refs — a Ref would resolve to the lowercased
// stored name and hide the FP) reference the groups above.
const source = new CfnDBInstance(stack, "Source", {
  engine: "mysql",
  dbInstanceClass: "db.t4g.micro",
  allocatedStorage: "20",
  masterUsername: "huntadmin",
  // NOT manageMasterUserPassword — RDS rejects creating a mysql read replica when the
  // source has managed master passwords enabled ("Creating read replicas for source
  // instance with engine mysql where ManageMasterUserPassword is enabled is not
  // supported", live 2026-08-02).
  masterUserPassword: "cdkrdHuntPassw0rd1",
  dbParameterGroupName: "CdkrdHunt-Mixed-DPG",
  dbSubnetGroupName: "CdkrdHunt-Mixed-SNG",
  publiclyAccessible: false,
  deletionProtection: false,
});
source.addDependency(pg);
source.addDependency(sng);

// Replica: BackupRetentionPeriod undeclared -> derived default 0 (#1704).
new CfnDBInstance(stack, "Replica", {
  sourceDbInstanceIdentifier: source.ref,
  dbInstanceClass: "db.t4g.micro",
  publiclyAccessible: false,
  deletionProtection: false,
});

app.synth();

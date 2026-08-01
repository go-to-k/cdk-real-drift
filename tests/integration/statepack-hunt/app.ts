// Stateful-pack first-run FP probe (2026-08-01 hunt):
// - RDS non-Aurora with AllocatedStorage 400 and StorageType UNDECLARED — the
//   ENGINE_DEFAULTS StorageType:'gp2' fold self-flags this open gap in its own
//   comment ("a large-storage config AWS provisions as gp3 by default would not
//   match"): postgres >=400 GiB materializes gp3 (+ Iops/StorageThroughput?).
// - RDS read replica (SourceDBInstanceIdentifier): a creation mode never
//   deployed — the replica inherits source properties the template never
//   declares (EngineVersion, AllocatedStorage, BackupRetentionPeriod 0, ...).
// - ElastiCache memcached barest: the ENGINE_DEFAULTS Port 11211 arm was
//   mirrored from the redis deploy (the only memcached fixture DECLARES Port /
//   AZMode / EngineVersion); NumCacheNodes 2 also probes the cross-az default.
// - Cassandra (Keyspaces) barest table (BillingMode echo undeclared) and
//   PROVISIONED table (the WarmThroughput {12000,4000} constant was harvested
//   from an ON_DEMAND read — a provisioned table may echo its own capacity).
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";
import { CfnCacheCluster, CfnSubnetGroup } from "aws-cdk-lib/aws-elasticache";
import { CfnKeyspace, CfnTable } from "aws-cdk-lib/aws-cassandra";
import { CfnSecurityGroup, CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const s = new Stack(app, "CdkrdHunt0801State");

// RDS source: engine/class/storage/creds ONLY — no StorageType, no
// EngineVersion, no BackupRetentionPeriod (default 1 keeps replica-creation
// legal). 400 GiB is the gp3-default territory the gp2 fold self-flags.
const src = new CfnDBInstance(s, "SrcDb", {
  engine: "postgres",
  dbInstanceClass: "db.t4g.micro",
  allocatedStorage: "400",
  masterUsername: "cdkrdhunt",
  masterUserPassword: "Cdkrd-hunt0801-pg!",
});
src.applyRemovalPolicy(RemovalPolicy.DESTROY);

// Read replica: creation-mode axis — only the source pointer + class declared.
const replica = new CfnDBInstance(s, "ReplicaDb", {
  sourceDbInstanceIdentifier: src.ref,
  dbInstanceClass: "db.t4g.micro",
});
replica.applyRemovalPolicy(RemovalPolicy.DESTROY);

// memcached barest (needs a subnet group in a VPC-only account setup; keep the
// cluster itself barest: engine + node type + count only).
const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.66.0.0/16" });
const sn1 = new CfnSubnet(s, "Sn1", {
  vpcId: vpc.ref,
  cidrBlock: "10.66.0.0/24",
  availabilityZone: "us-east-1a",
});
const sn2 = new CfnSubnet(s, "Sn2", {
  vpcId: vpc.ref,
  cidrBlock: "10.66.1.0/24",
  availabilityZone: "us-east-1b",
});
const cacheSubnets = new CfnSubnetGroup(s, "CacheSubnets", {
  description: "cdkrd hunt0801 memcached subnets",
  subnetIds: [sn1.ref, sn2.ref],
});
// Engine-axis validation difference (a finding in itself, like the valkey
// VpcSecurityGroupIds demand): CreateCacheCluster REJECTS a subnet-group
// memcached cluster without VpcSecurityGroupIds ("VpcSecurityGroupIds must be
// specified") while redis accepts the same shape — declare the minimum SG.
const mcSg = new CfnSecurityGroup(s, "McSg", {
  groupDescription: "cdkrd hunt0801 memcached sg",
  vpcId: vpc.ref,
});
const mc = new CfnCacheCluster(s, "Memcached0801", {
  engine: "memcached",
  cacheNodeType: "cache.t3.micro",
  numCacheNodes: 2,
  cacheSubnetGroupName: cacheSubnets.ref,
  vpcSecurityGroupIds: [mcSg.attrGroupId],
});
mc.applyRemovalPolicy(RemovalPolicy.DESTROY);

// Keyspaces: barest table + PROVISIONED table (WarmThroughput constant probe).
const ks = new CfnKeyspace(s, "Ks0801", { keyspaceName: "cdkrd_hunt0801" });
const barestTable = new CfnTable(s, "BarestTable", {
  keyspaceName: "cdkrd_hunt0801",
  tableName: "barest0801",
  partitionKeyColumns: [{ columnName: "pk", columnType: "text" }],
});
barestTable.addDependency(ks);
const provTable = new CfnTable(s, "ProvTable", {
  keyspaceName: "cdkrd_hunt0801",
  tableName: "prov0801",
  partitionKeyColumns: [{ columnName: "pk", columnType: "text" }],
  billingMode: {
    mode: "PROVISIONED",
    provisionedThroughput: { readCapacityUnits: 1, writeCapacityUnits: 1 },
  },
});
provTable.addDependency(ks);

app.synth();

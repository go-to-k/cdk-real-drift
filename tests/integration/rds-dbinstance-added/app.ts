// Minimal CDK app for the cdk-real-drift `added` integ test on RDS (the SEVENTEENTH
// CHILD_ENUMERATORS member). A minimal VPC (2 AZs, no NAT, isolated subnets) plus a
// minimal Aurora MySQL cluster with ONE declared writer instance, deletion protection
// OFF and removalPolicy DESTROY (no final snapshot) so teardown is fast and leaves no
// orphan. verify.sh then `create-db-instance`s an undeclared reader instance into the
// SAME cluster out of band (via the AWS CLI) — a whole DBInstance resource not in the
// template — and asserts cdkrd reports it under [Potential Drift] (PR4: an unrecorded added
// resource is inventory, not drift), records + watches it, and can revert (delete) it.
//
// An out-of-band DB instance that lingers in the cluster keeps billing AND can block the
// cluster's deletion, so verify.sh deletes any out-of-band instances off the cluster
// BEFORE delstack (see its cleanup trap).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  AuroraMysqlEngineVersion,
  ClusterInstance,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkrdIntegRdsDbInstanceAdded");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

new DatabaseCluster(stack, "Db", {
  engine: DatabaseClusterEngine.auroraMysql({
    // Use .of() (escape hatch) with a version confirmed available in-region via
    // `aws rds describe-db-engine-versions --engine aurora-mysql` — avoids both the
    // CDK enum gap and region-availability failures.
    version: AuroraMysqlEngineVersion.of("8.0.mysql_aurora.3.10.4", "8.0"),
  }),
  writer: ClusterInstance.provisioned("writer", {
    instanceType: InstanceType.of(InstanceClass.BURSTABLE3, InstanceSize.MEDIUM),
  }), // the declared writer instance — must NOT flag
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  removalPolicy: RemovalPolicy.DESTROY,
  deletionProtection: false,
});

app.synth();

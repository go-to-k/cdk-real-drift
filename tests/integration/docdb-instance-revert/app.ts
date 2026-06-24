// cdk-real-drift DocDB DBInstance detect->revert->clean integration test.
// The whole DocDB family is a Cloud Control read+write gap (UnsupportedActionException),
// so AWS::DocDB::DBInstance is read via DescribeDBInstances and HAD no writer — `revert`
// said "type not revertable yet" while detection worked, so an out-of-band instance
// change (resize / maintenance window / CA cert) was detected
// but could not be undone. The new writeDocDbInstance (ModifyDBInstance, mirror of the
// live-proven cluster writer) closes that gap. verify.sh declares a
// PreferredMaintenanceWindow, changes it out of band, asserts check DETECTS it, reverts, asserts check
// CLEAN + the live flag restored. Small isolated VPC (no NAT).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnDBCluster, CfnDBInstance, CfnDBSubnetGroup } from "aws-cdk-lib/aws-docdb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDocdbInstanceRevert");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});
const subnetGroup = new CfnDBSubnetGroup(stack, "SubnetGroup", {
  dbSubnetGroupDescription: "cdkrd docdb instance-revert subnet group",
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
});
const cluster = new CfnDBCluster(stack, "Cluster", {
  masterUsername: "cdkrduser",
  masterUserPassword: "Cdkrd-Test-Pw-9281",
  dbSubnetGroupName: subnetGroup.ref,
});
cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);

const instance = new CfnDBInstance(stack, "Instance", {
  dbClusterIdentifier: cluster.ref,
  dbInstanceClass: "db.t3.medium",
  preferredMaintenanceWindow: "sun:05:00-sun:06:00", // the revert subject (instance-level)
});
instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

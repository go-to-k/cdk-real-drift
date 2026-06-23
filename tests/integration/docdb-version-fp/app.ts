// cdk-real-drift DocDB DBCluster EngineVersion prefix false-positive test.
// Amazon DocumentDB expands a partial declared EngineVersion to a concrete one:
// declaring "5.0" provisions and reads back "5.0.0". cdkrd compares the declared
// "5.0" against the live "5.0.0" as a plain string, so a freshly recorded cluster
// false-drifts on EngineVersion unless the type is in VERSION_PREFIX_PATHS (the same
// fold RDS/Aurora/Neptune already use). Uses L1 CfnDBCluster with NO instance (a
// cluster alone provisions fast) in a small isolated VPC (no NAT) — the EngineVersion
// is the only subject. A freshly deployed + recorded cluster with NO out-of-band
// change MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnDBCluster, CfnDBSubnetGroup } from "aws-cdk-lib/aws-docdb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDocdbVersionFp");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const subnetGroup = new CfnDBSubnetGroup(stack, "SubnetGroup", {
  dbSubnetGroupDescription: "cdkrd docdb version-fp subnet group",
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
});

const cluster = new CfnDBCluster(stack, "Cluster", {
  // Declared as the PARTIAL "5.0"; DocDB reads it back as the concrete "5.0.0".
  engineVersion: "5.0",
  masterUsername: "cdkrduser",
  masterUserPassword: "Cdkrd-Test-Pw-9281",
  dbSubnetGroupName: subnetGroup.ref,
});
cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

// CDK app for the cdk-real-drift redshift-rich integration test.
// AWS::Redshift::Cluster is a common data-warehouse primitive. This fixture is the
// FP oracle for the "clean deploy -> zero potential drift" invariant (CLAUDE.md /
// DESIGN.md): a minimal RA3 single-node cluster declares only identity/sizing, so
// every OTHER value AWS returns is an initial/default it materialized. On a first
// `check` BEFORE `record`, NONE of them may surface as [Potential Drift] — they must
// all fold to atDefault. The RA3 node type is deliberate: RA3 clusters are ALWAYS
// encrypted, so `Encrypted=true` is an AWS-forced initial value (not user intent);
// `NumberOfNodes` is derived from `ClusterType=single-node`; `AvailabilityZone` /
// param-group name / snapshot windows / port are AWS-assigned. Mirrors the shape of
// the previously-orphaned Cluster corpus case (ra3.large, single-node).
// A single-node ra3.large on an isolated VPC is the cheapest provisionable RA3.
import { App, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnClusterSubnetGroup } from "aws-cdk-lib/aws-redshift";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRedshiftRich");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [{ name: "priv", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc });

const subnetGroup = new CfnClusterSubnetGroup(stack, "SubnetGroup", {
  description: "cdkrd integ redshift subnet group",
  subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
});

const cluster = new CfnCluster(stack, "Cluster", {
  clusterType: "single-node",
  nodeType: "ra3.large",
  dbName: "probe",
  masterUsername: "admin",
  masterUserPassword: "Cdkrd-Probe-123",
  clusterSubnetGroupName: subnetGroup.ref,
  vpcSecurityGroupIds: [sg.securityGroupId],
  publiclyAccessible: false,
});
cluster.addDependency(subnetGroup);

app.synth();

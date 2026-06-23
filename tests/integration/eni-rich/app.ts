// CDK app for the cdk-real-drift eni-rich integration test.
// AWS::EC2::NetworkInterface is a common building block in advanced VPC setups
// (fixed-IP appliances, multi-NIC instances, PrivateLink endpoints) and has NO
// golden-corpus coverage yet. It is FULLY_MUTABLE and Cloud Control read/update-
// capable, so it serves both halves: a freshly recorded ENI MUST check CLEAN (the
// false-positive half — GroupSet is a sg-id set AWS may reorder, Tags carry
// aws:* noise), and `SourceDestCheck` is a declared MUTABLE boolean a console edit
// can flip — the false-negative half (verify-detect.sh). A single ENI on a tiny
// no-NAT VPC is cheap and fast.
import { App, Stack } from "aws-cdk-lib";
import { CfnNetworkInterface, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEniRich");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 1,
  subnetConfiguration: [{ name: "pub", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const sg1 = new SecurityGroup(stack, "Sg1", { vpc, allowAllOutbound: true });
const sg2 = new SecurityGroup(stack, "Sg2", { vpc, allowAllOutbound: true });

new CfnNetworkInterface(stack, "Eni", {
  subnetId: vpc.publicSubnets[0]!.subnetId,
  description: "cdkrd integ network interface",
  // Two security groups (sg-… ids) — a set AWS may echo in its own order; cdkrd
  // sorts id-shaped scalar arrays generically, so this must not false-drift.
  groupSet: [sg1.securityGroupId, sg2.securityGroupId],
  // A declared MUTABLE boolean — the false-negative target (flip out of band).
  sourceDestCheck: true,
  tags: [{ key: "purpose", value: "cdkrd-integ" }],
});

app.synth();

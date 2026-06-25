// Minimal CDK app for the cdk-real-drift `added` integ test on EFS (the SIXTEENTH
// CHILD_ENUMERATORS member). A VPC with two public subnets in different AZs (no NAT) so
// teardown is fast and cheap, an EFS FileSystem, a SecurityGroup, and ONE declared
// MountTarget in the first subnet. verify.sh then `create-mount-target`s another mount
// target in the SECOND subnet out of band (via the AWS CLI) — a whole MountTarget
// resource not in the template — and asserts cdkrd reports it under [Potential Drift]
// (PR4: an unrecorded added resource is inventory, not drift), records + watches it,
// and can revert (delete) it.
//
// EFS allows ONE mount target per subnet/AZ, so the declared mount target sits in
// subnet[0] and verify.sh injects the out-of-band one into subnet[1]. An out-of-band
// mount target that lingers BLOCKS the FileSystem's deletion (CFn cannot delete a file
// system that still has mount targets), so verify.sh sweeps any injected mount targets
// off the file system BEFORE delstack (see its cleanup trap).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnFileSystem, CfnMountTarget } from "aws-cdk-lib/aws-efs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegEfsMountTargetAdded");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "p", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc });

const fs = new CfnFileSystem(stack, "Fs");
fs.applyRemovalPolicy(RemovalPolicy.DESTROY);

// The declared mount target — must NOT flag. Sits in subnet[0]; verify.sh injects an
// out-of-band one into subnet[1] (EFS allows one mount target per subnet/AZ).
new CfnMountTarget(stack, "DeclaredMt", {
  fileSystemId: fs.ref,
  subnetId: vpc.publicSubnets[0].subnetId,
  securityGroups: [sg.securityGroupId],
});

app.synth();

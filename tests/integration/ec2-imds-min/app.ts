// CDK app for the cdk-real-drift ec2-imds-min false-positive + detection test.
// BAREST t4g.nano instance with NO MetadataOptions declared — probes:
// 1. first-run: what the AL2023 AMI/account materializes for the undeclared
//    MetadataOptions (fold gap surface).
// 2. FN/detection: an out-of-band IMDSv2 DOWNGRADE (HttpTokens required ->
//    optional via ModifyInstanceMetadataOptions — the classic console/security
//    misconfiguration) MUST surface, and revert convergence is probed (the
//    audit flagged MetadataOptions as a possible #1366-class one-shot API gap).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  AmazonLinuxCpuType,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713bImds");

const vpc = new Vpc(stack, "HuntVpc", { maxAzs: 1, natGateways: 0 });

new Instance(stack, "HuntInstance", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
  machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
  associatePublicIpAddress: false,
});

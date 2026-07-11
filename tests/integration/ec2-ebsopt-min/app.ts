// CDK app for the cdk-real-drift ec2-ebsopt-min false-positive integration
// test. A BAREST L1 EC2 Instance on an EBS-OPTIMIZED-BY-DEFAULT family
// (m5.large): the live read returns EbsOptimized=true for an instance that
// never declared it — corpus only has t3.micro (EbsOptimized=false, which
// falls out via the trivially-empty husk), and noise.ts has NO EbsOptimized
// fold — so this probes an expected family-derived first-run FP (the #640
// class; EbsOptimized is derivable from the declared InstanceType).
// Minimal 1-AZ public VPC, no NAT; only ImageId/InstanceType/SubnetId
// declared on the instance.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  AmazonLinuxCpuType,
  CfnInstance,
  MachineImage,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegEc2EbsOptMin");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

new CfnInstance(stack, "HuntM5", {
  imageId: MachineImage.latestAmazonLinux2023({
    cpuType: AmazonLinuxCpuType.X86_64,
  }).getImage(stack).imageId,
  instanceType: "m5.large",
  subnetId: vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds[0],
});

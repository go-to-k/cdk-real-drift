// CDK app for the cdk-real-drift EC2 UserData false-positive test. CDK wraps an
// instance's UserData in `{ "Fn::Base64": { "Fn::Join"/"Fn::Sub": "…script…" } }`.
// UserData is a readable, mutable property on AWS::EC2::Instance, so until the
// resolver handles Fn::Base64 the declared value is UNRESOLVED — a blind spot that
// misses out-of-band UserData drift. With Fn::Base64 resolved, a freshly deployed +
// recorded instance with NO out-of-band change MUST report CLEAN: it proves the
// base64 of the resolved declared script matches the live (base64) UserData exactly,
// with no normalization FP. A single-AZ public subnet with NO NAT keeps it cheap.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AmazonLinuxCpuType,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  SubnetType,
  UserData,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEc2UserData");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [
    { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
  ],
});

const userData = UserData.forLinux();
userData.addCommands(
  "set -euo pipefail",
  "echo cdkrd-ec2-userdata-test > /tmp/marker",
  "yum install -y jq || true",
);

const instance = new Instance(stack, "Host", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: MachineImage.latestAmazonLinux2023({
    cpuType: AmazonLinuxCpuType.X86_64,
    cachedInContext: false,
  }),
  userData,
  // The default Amazon Linux 2023 SSM-managed AMI lookup pins via SSM parameter,
  // so no environment-specific context lookup is needed for synth.
});
instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

// CDK app for the cdk-real-drift EC2 Instance / EBS Volume false-positive +
// detection integration test. EC2 Instance is a daily-driver type cdkrd had NOT
// exercised before this fixture (no prior corpus/fixture). It DECLARES a stack of
// normalization-prone properties whose live AWS form is textually different but
// semantically equal:
//   - UserData      — CDK renders an Fn::Base64; the live read returns the base64 blob.
//   - MetadataOptions (IMDSv2 `HttpTokens=required`) — a nested object many users set.
//   - BlockDeviceMappings — an array of {DeviceName, Ebs:{...}} the API may reorder /
//     enrich (SnapshotId, KmsKeyId, the default Encrypted flag).
//   - Detailed monitoring (`Monitoring=true`) + CreditSpecification (t3 burstable).
//   - A standalone EBS Volume (gp3 with explicit Iops/Throughput) + VolumeAttachment.
// A minimal single-AZ VPC with no NAT keeps it cheap and self-cleaning.
import { App, Size, Stack, Tags } from "aws-cdk-lib";
import {
  AmazonLinuxCpuType,
  BlockDeviceVolume,
  CpuCredits,
  EbsDeviceVolumeType,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  SecurityGroup,
  SubnetType,
  UserData,
  Volume,
  CfnVolumeAttachment,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEc2Rich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc, allowAllOutbound: true });

const userData = UserData.forLinux();
userData.addCommands("echo 'cdkrd ec2-instance-rich fixture' > /tmp/hello");

const instance = new Instance(stack, "Host", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.X86_64 }),
  securityGroup: sg,
  userData,
  requireImdsv2: true, // MetadataOptions.HttpTokens = required
  detailedMonitoring: true, // Monitoring = true
  creditSpecification: CpuCredits.STANDARD,
  blockDevices: [
    {
      deviceName: "/dev/xvda",
      volume: BlockDeviceVolume.ebs(8, {
        volumeType: EbsDeviceVolumeType.GP3,
        encrypted: true,
        deleteOnTermination: true,
      }),
    },
  ],
});
Tags.of(instance).add("role", "bastion");

const dataVolume = new Volume(stack, "Data", {
  availabilityZone: vpc.publicSubnets[0]!.availabilityZone,
  size: Size.gibibytes(10),
  volumeType: EbsDeviceVolumeType.GP3,
  iops: 3000,
  throughput: 150, // non-default (gp3 default is 125) so it stays a DECLARED prop, not atDefault
  encrypted: true,
});
Tags.of(dataVolume).add("role", "data");

new CfnVolumeAttachment(stack, "DataAttach", {
  device: "/dev/sdf",
  instanceId: instance.instanceId,
  volumeId: dataVolume.volumeId,
});

app.synth();

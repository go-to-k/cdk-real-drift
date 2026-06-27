// CDK app for the cdk-real-drift EC2 Instance set-reorder false-positive
// integration test. It probes whether AWS reorders two `insertionOrder:false`
// object-array properties on AWS::EC2::Instance when Cloud Control reads them
// back:
//   - `Volumes` (attached EBS, keyed by Device/VolumeId — neither in
//     IDENTITY_FIELDS), declared NON-sorted by Device (/dev/sdg before /dev/sdf).
//   - `NetworkInterfaces` (keyed by DeviceIndex — not in IDENTITY_FIELDS),
//     declared NON-sorted by DeviceIndex (1 before 0).
// Both are declared out of order on purpose: if AWS canonicalizes (sorts) either
// set, a freshly recorded clean stack false-positives as declared drift.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AmazonLinuxCpuType,
  CfnInstance,
  CfnVolume,
  MachineImage,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

class Ec2InstanceSetsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const subnet = vpc.publicSubnets[0];
    const az = subnet.availabilityZone;

    const imageId = MachineImage.latestAmazonLinux2023({
      cpuType: AmazonLinuxCpuType.X86_64,
    }).getImage(this).imageId;

    // Two EBS volumes in the instance's AZ, attached in a non-sorted Device order.
    const vol1 = new CfnVolume(this, 'Vol1', { availabilityZone: az, size: 1, volumeType: 'gp3' });
    const vol2 = new CfnVolume(this, 'Vol2', { availabilityZone: az, size: 1, volumeType: 'gp3' });

    new CfnInstance(this, 'Inst', {
      imageId,
      instanceType: 't3.micro',
      availabilityZone: az,
      // NetworkInterfaces declared DeviceIndex 1 before 0 (non-sorted).
      networkInterfaces: [
        { deviceIndex: '1', subnetId: subnet.subnetId },
        { deviceIndex: '0', subnetId: subnet.subnetId },
      ],
      // Volumes declared /dev/sdg before /dev/sdf (non-sorted by Device).
      volumes: [
        { device: '/dev/sdg', volumeId: vol2.ref },
        { device: '/dev/sdf', volumeId: vol1.ref },
      ],
    });
  }
}

const app = new App();
new Ec2InstanceSetsStack(app, 'CdkRealDriftIntegEc2InstanceSets', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

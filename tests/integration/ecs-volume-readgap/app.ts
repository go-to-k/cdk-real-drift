// CDK app for the cdk-real-drift ECS Service VolumeConfigurations writeOnly-read-gap test.
//
// AWS::ECS::Service `VolumeConfigurations` (managed EBS volumes attached at deploy) is
// `writeOnlyProperties` — Cloud Control never echoes it (it lives on the service's
// deployments), so an out-of-band change to a volume's size / type was silently invisible.
// The SDK_SUPPLEMENTS reader reconstructs it from the PRIMARY deployment (PascalCased,
// with the AWS-defaulted FilesystemType "xfs" dropped). desiredCount 0 so no task runs.
import { App, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib';
import { EbsDeviceVolumeType, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  ServiceManagedVolume,
} from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';

class EcsVolumeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    const cluster = new Cluster(this, 'Cluster', { vpc });
    const taskDef = new FargateTaskDefinition(this, 'Task', { cpu: 256, memoryLimitMiB: 512 });
    const container = taskDef.addContainer('app', {
      image: ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest'),
    });

    const volume = new ServiceManagedVolume(this, 'Vol', {
      name: 'vol',
      managedEBSVolume: {
        volumeType: EbsDeviceVolumeType.GP3,
        size: Size.gibibytes(10),
      },
    });
    taskDef.addVolume(volume);
    container.addMountPoints({ containerPath: '/data', readOnly: false, sourceVolume: 'vol' });

    const svc = new FargateService(this, 'Svc', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 0,
    });
    svc.addVolume(volume);
    svc.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}

const app = new App();
new EcsVolumeStack(app, 'CdkRealDriftIntegEcsVolumeReadgap', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

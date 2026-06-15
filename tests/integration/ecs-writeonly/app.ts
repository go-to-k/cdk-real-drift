// Reproduction fixture for the Cloud-Control write-only-property drop on revert
// (cdkd #812 ported concern). An AWS::ECS::Service that carries a managed EBS
// volume synthesizes VolumeConfigurations, which is a **write-only** property:
// the CC-API read model never returns it. cdkrd's revert sends a minimal RFC6902
// patch (only the drifted path) via Cloud Control UpdateResource; Cloud Control
// read-modify-writes the full model (incl. the TaskDefinition that declares a
// `configuredAtLaunch` volume) but WITHOUT the dropped write-only
// VolumeConfigurations. UpdateService then rejects with "Task definition has
// configuredAtLaunch volume but no volume configuration provided at runtime".
//
// desiredCount: 0 → no task ever launches → fast deploy, no running container.
import { App, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import { EbsDeviceVolumeType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  ServiceManagedVolume,
} from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegEcsWriteonly");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const cluster = new Cluster(stack, "Cluster", { vpc });

const taskDefinition = new FargateTaskDefinition(stack, "TaskDef", {
  memoryLimitMiB: 512,
  cpu: 256,
});

const container = taskDefinition.addContainer("App", {
  image: ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:latest"),
  memoryLimitMiB: 512,
  command: ["echo", "hello"],
});

// Managed EBS volume → configuredAtLaunch volume on the task definition, plus
// VolumeConfigurations (write-only) on the service.
const ebsVolume = new ServiceManagedVolume(stack, "EbsVolume", {
  name: "ebs-data",
  managedEBSVolume: {
    size: Size.gibibytes(1),
    volumeType: EbsDeviceVolumeType.GP3,
  },
});
ebsVolume.mountIn(container, { containerPath: "/ebs-data", readOnly: false });
taskDefinition.addVolume(ebsVolume);

const service = new FargateService(stack, "Service", {
  cluster,
  taskDefinition,
  desiredCount: 0,
  assignPublicIp: true,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
});
service.addVolume(ebsVolume);

// Keep destroy clean.
service.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

// CDK app for the cdk-real-drift ecs-revision FN integration test. ECS Service is
// read NATIVELY via Cloud Control (composite id ServiceArn|Cluster); TaskDefinition
// is read via CC at the declared revision. The audit flagged a possible FN: when a
// TaskDefinition is updated out of band a NEW revision is created and the service is
// repointed to it. This fixture exists to PROVE whether cdkrd catches the Service's
// TaskDefinition pointer change (family:1 -> family:2) as declared drift. A minimal
// VPC + Fargate service (desiredCount 0 so no tasks actually run / bill).
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
} from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsRevision");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const cluster = new Cluster(stack, "Cluster", { vpc, clusterName: "cdkrd-ecs-revision" });

const taskDef = new FargateTaskDefinition(stack, "Task", { cpu: 256, memoryLimitMiB: 512 });
taskDef.addContainer("app", {
  image: ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:2"),
});

new FargateService(stack, "Service", {
  cluster,
  taskDefinition: taskDef,
  desiredCount: 0,
  serviceName: "cdkrd-ecs-revision-svc",
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
});

app.synth();

// CDK app for the cdk-real-drift ECS Service CapacityProviderStrategy reorder FP test.
// An ECS Service's `CapacityProviderStrategy` is a SET of {CapacityProvider,Weight,Base}
// with NO identity field (CapacityProvider is not Key/Id/Name), so neither
// canonicalizeTagListsDeep (identity-keyed) nor canonicalizeIdArraysDeep (id/method
// scalars) touches it — and it is in no UNORDERED_* allowlist. The FARGATE +
// FARGATE_SPOT weighted split is a STANDARD cost-optimization pattern. If ECS echoes the
// strategy in its own canonical order (on-demand before spot), a positional compare
// false-flags declared drift on a freshly deployed + recorded service. Declared
// SPOT-before-ON-DEMAND so a reorder is visible. A minimal VPC (one AZ) + cluster + task
// def + a desiredCount-0 service (no tasks scheduled — fast deploy/delete, no image pull).
// A clean recorded service MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
} from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsServiceCapacity");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "p", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const cluster = new Cluster(stack, "Cluster", {
  vpc,
  enableFargateCapacityProviders: true,
});
const taskDef = new FargateTaskDefinition(stack, "Task", { cpu: 256, memoryLimitMiB: 512 });
taskDef.addContainer("c", {
  image: ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:latest"),
  command: ["sleep", "3600"],
});

new FargateService(stack, "Svc", {
  cluster,
  taskDefinition: taskDef,
  desiredCount: 0,
  assignPublicIp: true,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  // Declared SPOT-before-ON-DEMAND, in non-canonical order, to surface any reorder.
  capacityProviderStrategies: [
    { capacityProvider: "FARGATE_SPOT", weight: 2 },
    { capacityProvider: "FARGATE", weight: 1, base: 1 },
  ],
});

app.synth();

// Minimal CDK app for the cdk-real-drift `added` integ test on ECS (the TWELFTH
// CHILD_ENUMERATORS member). A minimal VPC (one AZ, one public subnet, no NAT) + an ECS
// Cluster + a Fargate task def + a Fargate Service with desiredCount 0 (so NO tasks are
// scheduled — fast deploy/delete, no image pull). verify.sh then `create-service`s
// additional services on the SAME cluster out of band (via the AWS CLI) — whole Service
// resources not in the template — and asserts cdkrd reports them under [Not Recorded]
// (PR4: an unrecorded added resource is inventory, not drift), records + watches them,
// and can revert (delete) them.
//
// An out-of-band service that lingers on the cluster (one recorded but not reverted)
// BLOCKS the cluster's deletion (CFn cannot delete a cluster that still has active
// services) -> the stack goes DELETE_FAILED, so verify.sh's cleanup trap force-deletes
// any injected services off the cluster BEFORE delstack (see its cleanup trap).
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
} from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegEcsServiceAdded");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "p", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const cluster = new Cluster(stack, "Cluster", { vpc });
const taskDef = new FargateTaskDefinition(stack, "Task", { cpu: 256, memoryLimitMiB: 512 });
taskDef.addContainer("c", {
  image: ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:latest"),
  command: ["sleep", "3600"],
});
// desiredCount 0 -> no tasks scheduled (no image pull), fast deploy/delete. The declared
// service — must NOT flag.
new FargateService(stack, "Svc", {
  cluster,
  taskDefinition: taskDef,
  desiredCount: 0,
  assignPublicIp: true,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
});

app.synth();

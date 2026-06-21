// CDK app for the cdk-real-drift AWS Batch (Fargate) false-positive test. AWS Batch
// is a common managed-compute choice for batch/ETL workloads, and the `aws-batch`
// module emits three resource types cdkrd has never exercised: a Fargate
// ComputeEnvironment, a JobQueue, and an ECS JobDefinition. None require a NAT
// gateway to *create* (only running a job would pull an image), so an isolated VPC
// keeps the deploy fast and cheap. Each type carries its own normalization edges:
// the ComputeEnvironment's nested ComputeResources (subnets/security-groups/
// maxvCpus), the JobQueue's ComputeEnvironmentOrder, and the JobDefinition's nested
// ContainerProperties (Fargate platform config, resource requirements, network).
// A freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN.
import { App, Size, Stack } from "aws-cdk-lib";
import {
  EcsFargateContainerDefinition,
  EcsJobDefinition,
  FargateComputeEnvironment,
  JobQueue,
} from "aws-cdk-lib/aws-batch";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegBatchRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

const computeEnv = new FargateComputeEnvironment(stack, "FargateCE", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  maxvCpus: 16,
  spot: false,
});

const queue = new JobQueue(stack, "Queue", {
  priority: 1,
});
queue.addComputeEnvironment(computeEnv, 1);

new EcsJobDefinition(stack, "JobDef", {
  retryAttempts: 2,
  container: new EcsFargateContainerDefinition(stack, "Container", {
    image: ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:latest"),
    cpu: 0.25,
    memory: Size.mebibytes(512),
  }),
});

app.synth();

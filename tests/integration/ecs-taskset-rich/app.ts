// CDK app for the cdk-real-drift ECS TaskSet read-gap test.
// AWS::ECS::TaskSet has a THREE-part Cloud Control primaryIdentifier
// [Cluster, Service, Id], while its CFn physical id is only the bare task-set Id.
// cdkrd's composite-id helper only joins a SINGLE parent, so without a dedicated
// 3-part adapter a declared TaskSet is silently `skipped` (read-gap) on every
// check — its undeclared/declared drift invisible. This is the same read-gap
// class as the AutoScaling ScheduledAction composite (#288), one segment deeper.
// A freshly deployed + recorded stack MUST be CLEAN and the TaskSet must NOT be
// skipped (skipped=0).
import { App, Stack } from "aws-cdk-lib";
import { Vpc, SecurityGroup, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  CfnService,
  CfnTaskSet,
  FargateTaskDefinition,
} from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsTaskSetRich");

// Fast, NAT-free VPC: public subnets only so the Fargate task can pull its image
// over an internet gateway (assignPublicIp ENABLED) without a ~3-min NAT.
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC }],
});

const cluster = new Cluster(stack, "Cluster", { vpc });

const taskDef = new FargateTaskDefinition(stack, "TaskDef", {
  cpu: 256,
  memoryLimitMiB: 512,
});
taskDef.addContainer("web", {
  image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:latest"),
  portMappings: [{ containerPort: 80 }],
});

const sg = new SecurityGroup(stack, "TaskSg", { vpc, allowAllOutbound: true });

// EXTERNAL deployment controller: the service holds no task definition itself;
// task sets are attached to it. This is the only way to declare a CfnTaskSet.
const service = new CfnService(stack, "Service", {
  cluster: cluster.clusterArn,
  serviceName: "cdkrd-integ-taskset-svc",
  deploymentController: { type: "EXTERNAL" },
  schedulingStrategy: "REPLICA",
});

const taskSet = new CfnTaskSet(stack, "TaskSet", {
  cluster: cluster.clusterArn,
  service: service.attrName,
  taskDefinition: taskDef.taskDefinitionArn,
  launchType: "FARGATE",
  platformVersion: "LATEST",
  scale: { value: 100, unit: "PERCENT" },
  networkConfiguration: {
    awsVpcConfiguration: {
      subnets: vpc.publicSubnets.map((s) => s.subnetId),
      securityGroups: [sg.securityGroupId],
      assignPublicIp: "ENABLED",
    },
  },
});
taskSet.addDependency(service);

app.synth();

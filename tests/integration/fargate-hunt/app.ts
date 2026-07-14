// False-positive probe (real AWS): barest L1 FARGATE service — the default
// ECS mode, yet only the EC2 launch type has a barest fixture
// (ecs-ec2-service-min); every Fargate fixture is a rich L2. A barest Fargate
// service surfaces the Fargate-side default family: PlatformVersion,
// DeploymentConfiguration (MaximumPercent/MinimumHealthyPercent + circuit
// breaker), DeploymentController, AssignPublicIp=DISABLED, default
// SecurityGroups echo, SchedulingStrategy, EnableECSManagedTags,
// AvailabilityZoneRebalancing. DesiredCount is pinned to 0 so no task ever
// starts (no image pull, no NAT/IGW needed, nothing bills) and CFn's
// service-stability wait cannot hang.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnService, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Fargate");

const vpc = new CfnVPC(stack, "HuntVpc", { cidrBlock: "10.61.0.0/16" });
const subnet = new CfnSubnet(stack, "HuntSubnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.61.0.0/24",
  availabilityZone: "us-east-1a",
});

const cluster = new CfnCluster(stack, "HuntCluster", {});

const taskDef = new CfnTaskDefinition(stack, "HuntTaskDef", {
  requiresCompatibilities: ["FARGATE"],
  networkMode: "awsvpc",
  cpu: "256",
  memory: "512",
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/docker/library/busybox:stable",
    },
  ],
});

new CfnService(stack, "HuntFargateSvc", {
  cluster: cluster.ref,
  taskDefinition: taskDef.ref,
  launchType: "FARGATE",
  desiredCount: 0,
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: [subnet.ref],
    },
  },
});

app.synth();

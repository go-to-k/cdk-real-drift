// Revert-convergence probe (real AWS): ECS Service
// NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp folds to 'DISABLED'
// (KNOWN_DEFAULT_PATHS, #1610) but UpdateService is a SELECTIVE-modify API and
// the ECS SDK_NESTED_WRITERS cover only ServiceConnect/VolumeConfigurations —
// whether a bare `remove` (or the CC patch) converges an out-of-band
// ENABLED flip back to DISABLED has never been probed. Barest Fargate service
// with desiredCount 0 (no tasks ever launch — free), AssignPublicIp UNDECLARED.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnSecurityGroup, CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnService, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722EcsNet");

const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.72.0.0/16" });
const subnet = new CfnSubnet(stack, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.72.0.0/24",
  availabilityZone: "us-east-1a",
});
const sg = new CfnSecurityGroup(stack, "Sg", {
  groupDescription: "cdkrd ecsnet-hunt",
  vpcId: vpc.ref,
});

const cluster = new CfnCluster(stack, "HuntCluster", {
  clusterName: "cdkrd-hunt0722-ecsnet",
});

const taskDef = new CfnTaskDefinition(stack, "HuntTaskDef", {
  family: "cdkrd-hunt0722-ecsnet",
  requiresCompatibilities: ["FARGATE"],
  networkMode: "awsvpc",
  cpu: "256",
  memory: "512",
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/docker/library/busybox:stable",
      essential: true,
    },
  ],
});

new CfnService(stack, "HuntService", {
  cluster: cluster.ref,
  serviceName: "cdkrd-hunt0722-ecsnet-svc",
  taskDefinition: taskDef.ref,
  launchType: "FARGATE",
  desiredCount: 0,
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: [subnet.ref],
      securityGroups: [sg.attrGroupId],
    },
  },
});

app.synth();

// CDK app for the cdk-real-drift ecs-ec2-service-min false-positive
// integration test. BAREST-possible EC2-launch-type ECS Service
// (DesiredCount=0, so no container instances are needed and nothing runs):
// every corpus Service is Fargate/awsvpc, and the GENERATED_TOPLEVEL_PATHS
// `Role` fold is explicitly commented as awsvpc/Fargate-only — an EC2+bridge
// service materializes the service-linked Role (and scheduling defaults)
// differently, never exercised live.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnCluster, CfnService, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegEcsEc2ServiceMin");

const cluster = new CfnCluster(stack, "HuntCluster", {
  clusterName: "cdkrd-hunt-ec2svc-cluster",
});

const taskDef = new CfnTaskDefinition(stack, "HuntBridgeTaskDef", {
  family: "cdkrd-hunt-ec2svc-td",
  requiresCompatibilities: ["EC2"],
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/docker/library/busybox:stable",
      memory: 128,
    },
  ],
});

new CfnService(stack, "HuntEc2Service", {
  cluster: cluster.ref,
  taskDefinition: taskDef.ref,
  launchType: "EC2",
  desiredCount: 0,
});

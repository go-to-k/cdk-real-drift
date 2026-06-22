// CDK app for the cdk-real-drift ECS Service multi-target-group false-positive
// test. AWS::ECS::Service.LoadBalancers is an identity-LESS object array
// ({ContainerName, ContainerPort, TargetGroupArn, ...}) that a service behind an
// ALB can hold MULTIPLE of (one container exposing two ports, each registered to
// its own target group — a common multi-listener / blue-green shape). It is NOT
// in any noise.ts fold table, so if ECS returns the set in its own canonical
// order a positional diff would false-flag every shifted entry as declared drift
// — the same set-reorder FP class as EC2 SecurityGroup rules / ELBv2 ListenerRule
// Conditions. This fixture declares the two LoadBalancers entries in DELIBERATELY
// NON-canonical order (port 8080 first) so a reorder, if ECS performs one, is
// revealed: a freshly deployed + recorded service MUST classify CLEAN.
//
// NAT-free + fast: internal ALB in PRIVATE_ISOLATED subnets, desiredCount 0 so no
// task is scheduled (no image pull) — the LoadBalancers config is stored on the
// service regardless of running tasks.
import { App, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  CfnService,
  Cluster,
  ContainerImage,
  FargateTaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsServiceLbRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const cluster = new Cluster(stack, "Cluster", { vpc });

const taskDef = new FargateTaskDefinition(stack, "TaskDef", { cpu: 256, memoryLimitMiB: 512 });
taskDef.addContainer("web", {
  image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:latest"),
  portMappings: [{ containerPort: 80 }, { containerPort: 8080 }],
});

const alb = new ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  loadBalancerName: "cdkrd-ecs-lb-rich",
});

const tg80 = new ApplicationTargetGroup(stack, "Tg80", {
  vpc,
  targetGroupName: "cdkrd-ecs-lb-tg80",
  port: 80,
  protocol: ApplicationProtocol.HTTP,
  targetType: TargetType.IP,
});
const tg8080 = new ApplicationTargetGroup(stack, "Tg8080", {
  vpc,
  targetGroupName: "cdkrd-ecs-lb-tg8080",
  port: 8080,
  protocol: ApplicationProtocol.HTTP,
  targetType: TargetType.IP,
});

const l80 = alb.addListener("L80", { port: 80, protocol: ApplicationProtocol.HTTP, defaultTargetGroups: [tg80] });
const l8080 = alb.addListener("L8080", {
  port: 8080,
  protocol: ApplicationProtocol.HTTP,
  defaultTargetGroups: [tg8080],
});

const sg = new SecurityGroup(stack, "Sg", { vpc, allowAllOutbound: true });

const service = new CfnService(stack, "Service", {
  cluster: cluster.clusterArn,
  serviceName: "cdkrd-integ-ecs-lb-svc",
  taskDefinition: taskDef.taskDefinitionArn,
  desiredCount: 0,
  launchType: "FARGATE",
  // Declared NON-canonical (port 8080 entry first): if ECS canonicalizes the
  // LoadBalancers set into a different order, a positional compare surfaces it.
  loadBalancers: [
    { containerName: "web", containerPort: 8080, targetGroupArn: tg8080.targetGroupArn },
    { containerName: "web", containerPort: 80, targetGroupArn: tg80.targetGroupArn },
  ],
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: vpc.isolatedSubnets.map((s) => s.subnetId),
      securityGroups: [sg.securityGroupId],
      assignPublicIp: "DISABLED",
    },
  },
});
// The service can only be created once each target group is associated with a
// listener on the ALB.
service.node.addDependency(l80);
service.node.addDependency(l8080);

app.synth();

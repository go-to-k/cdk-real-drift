// CDK app for the cdk-real-drift modes-hunt integration test (2026-08-09 hunt).
// Two high-signal 2025-era mode arms on top-10 types, sharing one VPC + one
// internal ALB (offline audit 2026-08-09; both had ZERO corpus/fixture hits):
//   - ECS Service DeploymentConfiguration.Strategy=BLUE_GREEN with the
//     loadBalancer advancedConfiguration block (alternate TG + listener rule +
//     infrastructure role) and BakeTimeInMinutes declared — every existing ECS
//     Service case is ROLLING; probes the whole new-config-family echo
//   - AWS::CloudFront::VpcOrigin pointed at the internal ALB, barest
//     (VpcOriginEndpointConfig with only Name+Arn — HTTPPort/HTTPSPort/
//     OriginProtocolPolicy/OriginSSLProtocols left to AWS service fill)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnVpcOrigin } from "aws-cdk-lib/aws-cloudfront";
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnService, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import {
  CfnListener,
  CfnListenerRule,
  CfnLoadBalancer,
  CfnTargetGroup,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0809Modes");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  restrictDefaultSecurityGroup: false,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC }],
});

const albSg = new SecurityGroup(stack, "AlbSg", { vpc, allowAllOutbound: true });
albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(80));
const taskSg = new SecurityGroup(stack, "TaskSg", { vpc, allowAllOutbound: true });
taskSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(80));

const alb = new CfnLoadBalancer(stack, "Alb", {
  name: "cdkrd-hunt-0809-modes-alb",
  type: "application",
  scheme: "internal",
  securityGroups: [albSg.securityGroupId],
  subnets: vpc.publicSubnets.map((s) => s.subnetId),
});

const blueTg = new CfnTargetGroup(stack, "BlueTg", {
  name: "cdkrd-hunt-0809-blue",
  protocol: "HTTP",
  port: 80,
  vpcId: vpc.vpcId,
  targetType: "ip",
});
const greenTg = new CfnTargetGroup(stack, "GreenTg", {
  name: "cdkrd-hunt-0809-green",
  protocol: "HTTP",
  port: 80,
  vpcId: vpc.vpcId,
  targetType: "ip",
});

const listener = new CfnListener(stack, "Listener", {
  loadBalancerArn: alb.ref,
  protocol: "HTTP",
  port: 80,
  defaultActions: [{ type: "forward", targetGroupArn: blueTg.ref }],
});
const prodRule = new CfnListenerRule(stack, "ProdRule", {
  listenerArn: listener.ref,
  priority: 1,
  conditions: [{ field: "path-pattern", pathPatternConfig: { values: ["/*"] } }],
  actions: [{ type: "forward", targetGroupArn: blueTg.ref }],
});

// ── ECS blue/green service ──
const cluster = new CfnCluster(stack, "Cluster", { clusterName: "cdkrd-hunt-0809-modes" });
const execRole = new Role(stack, "ExecRole", {
  assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
  ],
});
const infraRole = new Role(stack, "InfraRole", {
  assumedBy: new ServicePrincipal("ecs.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName("AmazonECSInfrastructureRolePolicyForLoadBalancers"),
  ],
});
const taskDef = new CfnTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-hunt-0809-modes",
  requiresCompatibilities: ["FARGATE"],
  cpu: "256",
  memory: "512",
  networkMode: "awsvpc",
  executionRoleArn: execRole.roleArn,
  containerDefinitions: [
    {
      name: "web",
      image: "public.ecr.aws/nginx/nginx:alpine",
      essential: true,
      portMappings: [{ containerPort: 80, protocol: "tcp" }],
    },
  ],
});
const svc = new CfnService(stack, "BgService", {
  serviceName: "cdkrd-hunt-0809-bg",
  cluster: cluster.ref,
  taskDefinition: taskDef.ref,
  desiredCount: 1,
  launchType: "FARGATE",
  deploymentConfiguration: {
    strategy: "BLUE_GREEN",
    bakeTimeInMinutes: 0,
  },
  networkConfiguration: {
    awsvpcConfiguration: {
      assignPublicIp: "ENABLED",
      subnets: vpc.publicSubnets.map((s) => s.subnetId),
      securityGroups: [taskSg.securityGroupId],
    },
  },
  loadBalancers: [
    {
      containerName: "web",
      containerPort: 80,
      targetGroupArn: blueTg.ref,
      advancedConfiguration: {
        alternateTargetGroupArn: greenTg.ref,
        productionListenerRule: prodRule.ref,
        roleArn: infraRole.roleArn,
      },
    },
  ],
});
svc.addDependency(prodRule);

// ── CloudFront VPC origin (barest endpoint config) ──
new CfnVpcOrigin(stack, "VpcOrigin", {
  vpcOriginEndpointConfig: {
    name: "cdkrd-hunt-0809-vpco",
    arn: alb.ref,
  },
});

app.synth();

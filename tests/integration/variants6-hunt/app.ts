// 2026-08-10 hunt: un-deployed variant branches (Round-0 audit).
//  - ECS Service SchedulingStrategy=DAEMON — every corpus service is REPLICA;
//    AWS documents the DAEMON rollout band as MaximumPercent=100 /
//    MinimumHealthyPercent=0, which the REPLICA-derived 200/100 pins would
//    mis-fold; DesiredCount is undeclarable for DAEMON and echoes ECS's count.
//  - Batch ComputeEnvironment ComputeResources.Type=SPOT — corpus covers
//    EC2 / FARGATE / FARGATE_SPOT / UNMANAGED; the EC2-SPOT arm reads back
//    BidPercentage / AllocationStrategy echoes with no fold.
//  - Glue Job Command.Name=glueray — RULED OUT live (2026-08-10): create fails
//    with "Account not allowed to submit Glue Ray job Post Deprecation" — Ray
//    jobs are deprecated and CFn-unreachable for current accounts, so the
//    glueetl-scoped 'Command.PythonVersion': '2' pin can never FP on a Ray job.
//  - NLB UDP + TCP_UDP listeners — Listener attributes have no BY_PROTOCOL
//    split (unlike TargetGroup); the UDP arms never deployed.
// First `check` (pre-record) must show ZERO [Potential Drift].
import { App, Fn, Stack, Tags } from "aws-cdk-lib";
import { CfnComputeEnvironment } from "aws-cdk-lib/aws-batch";
import { CfnSecurityGroup, CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnService, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import {
  CfnListener,
  CfnLoadBalancer,
  CfnTargetGroup,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnInstanceProfile, CfnRole } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0810Var");

// --- shared VPC ---
const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.0.0.0/24" });
const subnet = new CfnSubnet(stack, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.0.0/25",
  availabilityZone: Fn.select(0, Fn.getAzs()),
});

// --- ECS DAEMON service (no DesiredCount, no DeploymentConfiguration) ---
const cluster = new CfnCluster(stack, "EcsCluster", {
  clusterName: "cdkrd-0810v-cluster",
});
const taskDef = new CfnTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-0810v-td",
  requiresCompatibilities: ["EC2"],
  containerDefinitions: [
    { name: "app", image: "public.ecr.aws/docker/library/busybox:stable", memory: 128 },
  ],
});
new CfnService(stack, "DaemonService", {
  cluster: cluster.ref,
  taskDefinition: taskDef.ref,
  launchType: "EC2",
  schedulingStrategy: "DAEMON",
});

// --- Batch EC2-SPOT compute environment (MinvCpus 0 -> no instances launch) ---
const sg = new CfnSecurityGroup(stack, "BatchSg", {
  groupDescription: "cdkrd 0810 batch spot",
  vpcId: vpc.ref,
});
const instanceRole = new CfnRole(stack, "BatchInstanceRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  },
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
  ],
});
const instanceProfile = new CfnInstanceProfile(stack, "BatchInstanceProfile", {
  roles: [instanceRole.ref],
});
const spotFleetRole = new CfnRole(stack, "SpotFleetRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "spotfleet.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole"],
});
new CfnComputeEnvironment(stack, "SpotCe", {
  computeEnvironmentName: "cdkrd-0810v-spotce",
  type: "MANAGED",
  computeResources: {
    type: "SPOT",
    minvCpus: 0,
    maxvCpus: 1,
    subnets: [subnet.ref],
    securityGroupIds: [sg.ref],
    instanceTypes: ["optimal"],
    instanceRole: instanceProfile.attrArn,
    spotIamFleetRole: spotFleetRole.attrArn,
  },
});

// --- internal NLB + UDP / TCP_UDP listeners ---
const nlb = new CfnLoadBalancer(stack, "Nlb", {
  name: "cdkrd-0810v-nlb",
  type: "network",
  scheme: "internal",
  subnets: [subnet.ref],
});
const udpTg = new CfnTargetGroup(stack, "UdpTg", {
  name: "cdkrd-0810v-udp-tg",
  protocol: "UDP",
  port: 53,
  vpcId: vpc.ref,
  targetType: "instance",
});
const tcpUdpTg = new CfnTargetGroup(stack, "TcpUdpTg", {
  name: "cdkrd-0810v-tu-tg",
  protocol: "TCP_UDP",
  port: 54,
  vpcId: vpc.ref,
  targetType: "instance",
});
new CfnListener(stack, "UdpListener", {
  loadBalancerArn: nlb.ref,
  protocol: "UDP",
  port: 53,
  defaultActions: [{ type: "forward", targetGroupArn: udpTg.ref }],
});
new CfnListener(stack, "TcpUdpListener", {
  loadBalancerArn: nlb.ref,
  protocol: "TCP_UDP",
  port: 54,
  defaultActions: [{ type: "forward", targetGroupArn: tcpUdpTg.ref }],
});

app.synth();

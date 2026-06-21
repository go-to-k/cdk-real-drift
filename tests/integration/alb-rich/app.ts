// CDK app for the cdk-real-drift Application Load Balancer false-positive test.
// An internal ALB + target group + HTTP listener is one of the most common
// networking patterns. It exercises the FP-prone LoadBalancerAttributes bag
// (idle_timeout, http2.enabled, deletion_protection, desync mitigation) and the
// TargetGroupAttributes bag (deregistration_delay, stickiness) plus a health
// check — attribute key/value lists ELBv2 default-fills server-side. Internal +
// isolated subnets keep it NAT-free and fast. A freshly deployed + recorded ALB
// with NO out-of-band change MUST report CLEAN.
import { App, Duration, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAlbRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

const alb = new ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  loadBalancerName: "cdkrd-alb-rich",
  idleTimeout: Duration.seconds(120),
  http2Enabled: true,
  deletionProtection: false,
});

const tg = new ApplicationTargetGroup(stack, "Tg", {
  vpc,
  targetGroupName: "cdkrd-tg-rich",
  port: 80,
  protocol: ApplicationProtocol.HTTP,
  targetType: TargetType.IP,
  deregistrationDelay: Duration.seconds(30),
  healthCheck: {
    path: "/health",
    interval: Duration.seconds(30),
    healthyThresholdCount: 3,
  },
});

alb.addListener("Listener", {
  port: 80,
  protocol: ApplicationProtocol.HTTP,
  defaultTargetGroups: [tg],
});

app.synth();

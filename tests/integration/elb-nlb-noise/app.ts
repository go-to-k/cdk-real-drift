// CDK app for the cdk-real-drift ELB first-run-noise harvest. Two bare internal
// load balancers in isolated subnets (NAT-free):
//   - a Network Load Balancer (NLB) — its server-default attribute bag uses keys
//     (and defaults) DIFFERENT from an ALB's, none of which the ALB-only
//     ELB_ATTRIBUTE_DEFAULTS entries cover, so a fresh NLB lists them all under
//     [Potential Drift]. Harvest the live values to curate the NLB defaults.
//   - an Application Load Balancer (ALB) with NO idleTimeout declared — so
//     `idle_timeout.timeout_seconds` reads back the live default "60" UNDECLARED
//     (every other ELB fixture declares idleTimeout, hiding it from the corpus).
// A freshly deployed + recorded stack MUST be CLEAN; the value is the harvested
// live attribute bags that grow ELB_ATTRIBUTE_DEFAULTS.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationLoadBalancer,
  NetworkLoadBalancer,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbNlbNoise");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

// Bare ALB: no idleTimeout -> idle_timeout.timeout_seconds=60 reads back undeclared.
new ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  loadBalancerName: "cdkrd-elbnlb-alb",
});

// Internal NLB: harvest its server-default attribute bag.
new NetworkLoadBalancer(stack, "Nlb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  loadBalancerName: "cdkrd-elbnlb-nlb",
});

app.synth();

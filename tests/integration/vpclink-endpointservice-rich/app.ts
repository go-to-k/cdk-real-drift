// CDK app for the cdk-real-drift vpclink-endpointservice-rich false-positive
// integration test. Exercises two PrivateLink-adjacent types cdkrd has never read:
//   - AWS::EC2::VPCEndpointService — the provider side of PrivateLink, backed by an
//     internal NLB. AcceptanceRequired is declared true (and is the mutable knob the
//     detect script flips); SupportedIpAddressTypes is a declared scalar set.
//   - AWS::ApiGatewayV2::VpcLink — SubnetIds (2 AZs) and SecurityGroupIds (two SGs,
//     declared in non-sorted order) are set-like scalar arrays AWS may echo in its own
//     order: a reorder-FP probe.
// Isolated subnets, no NAT, internal NLB with no listener/targets — nothing runs, so
// deploy/delete is fast and cheap (NLB hourly is the only cost for the test window).
import { App, Stack } from "aws-cdk-lib";
import { VpcLink } from "aws-cdk-lib/aws-apigatewayv2";
import { CfnVPCEndpointService, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { NetworkLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegVpcLinkEndpointSvc");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const nlb = new NetworkLoadBalancer(stack, "Nlb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
});

new CfnVPCEndpointService(stack, "EndpointService", {
  networkLoadBalancerArns: [nlb.loadBalancerArn],
  acceptanceRequired: true,
  supportedIpAddressTypes: ["ipv4"],
});

// Two SGs declared z-before-a so any live-side sort of SecurityGroupIds surfaces
// as a positional mismatch instead of hiding behind an already-sorted declaration.
const sgZ = new SecurityGroup(stack, "SgZ", { vpc, description: "cdkrd hunt vpclink z" });
const sgA = new SecurityGroup(stack, "SgA", { vpc, description: "cdkrd hunt vpclink a" });

new VpcLink(stack, "Link", {
  vpc,
  vpcLinkName: "cdkrd-hunt-vpclink",
  subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  securityGroups: [sgZ, sgA],
});

app.synth();

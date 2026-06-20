// CDK app for the cdk-real-drift VPC false-positive test.
// A standard ec2.Vpc is one of the most commonly deployed CDK patterns and expands
// to many resources with many AWS-populated defaults (VPC, subnets, route tables,
// routes, IGW, NAT gateway, EIP, gateway endpoint). It is a dense stress test of
// default-folding and undeclared-property classification across networking types.
// A freshly deployed + recorded VPC with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  GatewayVpcEndpointAwsService,
  IpAddresses,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegVpcCommon");

new Vpc(stack, "Net", {
  ipAddresses: IpAddresses.cidr("10.42.0.0/16"),
  maxAzs: 2,
  natGateways: 1,
  subnetConfiguration: [
    { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
    { name: "private", subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
  ],
  gatewayEndpoints: {
    S3: { service: GatewayVpcEndpointAwsService.S3 },
  },
});

app.synth();

// CDK app for the cdk-real-drift vpc-attach-min false-positive integration
// test. BAREST-possible configs of zero-coverage everyday VPC attachments
// (all free while attached):
// - AWS::EC2::InstanceConnectEndpoint: the modern private-subnet SSH path —
//   only SubnetId declared (PreserveClientIp / SecurityGroupIds defaults echo).
// - AWS::EC2::EIPAssociation: EIP attached to a bare ENI — AllocationId /
//   NetworkInterfaceId echoes plus the association's AWS-assigned id.
// - AWS::EC2::VPCCidrBlock (amazon-provided IPv6) + AWS::EC2::SubnetCidrBlock:
//   dual-stack assignment branch never exercised (vpc fixtures are IPv4-only).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Fn, Stack, Tags } from "aws-cdk-lib";
import {
  CfnEIP,
  CfnEIPAssociation,
  CfnInstanceConnectEndpoint,
  CfnNetworkInterface,
  CfnSubnetCidrBlock,
  CfnVPCCidrBlock,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegVpcAttachMin");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const subnetId = vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds[0];

new CfnInstanceConnectEndpoint(stack, "HuntIce", {
  subnetId,
});

const eni = new CfnNetworkInterface(stack, "HuntEni", {
  subnetId,
});
const eip = new CfnEIP(stack, "HuntEip", {});
new CfnEIPAssociation(stack, "HuntEipAssoc", {
  allocationId: eip.attrAllocationId,
  networkInterfaceId: eni.ref,
});

const ipv6Block = new CfnVPCCidrBlock(stack, "HuntIpv6Block", {
  vpcId: vpc.vpcId,
  amazonProvidedIpv6CidrBlock: true,
});

const subnetIpv6 = new CfnSubnetCidrBlock(stack, "HuntSubnetIpv6", {
  subnetId,
  ipv6CidrBlock: Fn.select(0, Fn.cidr(Fn.select(0, vpc.vpcIpv6CidrBlocks), 1, "64")),
});
subnetIpv6.addDependency(ipv6Block);

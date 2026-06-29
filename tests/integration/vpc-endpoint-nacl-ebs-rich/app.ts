// CDK app for the cdk-real-drift Interface VPC Endpoint / NetworkAcl entries / EBS
// volume-type false-positive integration test. Three commonly-deployed, previously
// thin-on-corpus networking shapes packed into one cheap (NAT-free, isolated-subnet)
// VPC:
//   - InterfaceVpcEndpoint (Secrets Manager) across 2 subnets with 2 security groups
//     + PrivateDnsEnabled. SubnetIds / SecurityGroupIds are ID arrays AWS may REORDER
//     relative to the template (canonicalizeIdArraysDeep should fold this) and the
//     corpus previously only covered a GATEWAY endpoint (S3, RouteTableIds shape).
//   - A NetworkAcl with several NetworkAclEntry resources (ingress/egress, varied
//     RuleNumber). Entries are separate resources AWS returns ordered by RuleNumber.
//   - EBS Volumes of types the corpus did not cover: gp2 (implicit size-derived Iops)
//     and io2 (explicit Iops). The existing corpus only had a gp3 volume.
// A freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN.
import { App, Size, Stack, Tags } from "aws-cdk-lib";
import {
  AclCidr,
  AclTraffic,
  Action,
  EbsDeviceVolumeType,
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  NetworkAcl,
  SecurityGroup,
  SubnetType,
  TrafficDirection,
  Volume,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegVpcEpRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const epSg1 = new SecurityGroup(stack, "EpSg1", { vpc, description: "endpoint sg 1" });
const epSg2 = new SecurityGroup(stack, "EpSg2", { vpc, description: "endpoint sg 2" });

new InterfaceVpcEndpoint(stack, "SecretsEp", {
  vpc,
  service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  securityGroups: [epSg1, epSg2],
  privateDnsEnabled: true,
});

const nacl = new NetworkAcl(stack, "Nacl", {
  vpc,
  subnetSelection: { subnetType: SubnetType.PRIVATE_ISOLATED },
});
nacl.addEntry("InHttps", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.tcpPort(443),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 100,
  ruleAction: Action.ALLOW,
});
nacl.addEntry("InEphemeral", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.tcpPortRange(1024, 65535),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 110,
  ruleAction: Action.ALLOW,
});
nacl.addEntry("OutAll", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.allTraffic(),
  direction: TrafficDirection.EGRESS,
  ruleNumber: 100,
  ruleAction: Action.ALLOW,
});

const az = vpc.availabilityZones[0]!;
const gp2 = new Volume(stack, "Gp2Vol", {
  availabilityZone: az,
  size: Size.gibibytes(20),
  volumeType: EbsDeviceVolumeType.GP2, // AWS derives Iops from size (≈100 here) — undeclared
  encrypted: true,
});
Tags.of(gp2).add("role", "gp2");

const io2 = new Volume(stack, "Io2Vol", {
  availabilityZone: az,
  size: Size.gibibytes(10),
  volumeType: EbsDeviceVolumeType.IO2,
  iops: 1000, // io2 requires explicit provisioned Iops — declared
  encrypted: true,
});
Tags.of(io2).add("role", "io2");

app.synth();

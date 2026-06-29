// CDK app for the cdk-real-drift NetworkAclEntry read-gap integration test.
// AWS::EC2::NetworkAclEntry has NO Cloud Control read handler (GetResource throws
// UnsupportedActionException), so every NACL entry was silently `skipped` — a rule changed
// out of band (a CidrBlock widened, an action flipped allow->deny) was invisible (a silent
// false negative on a security-relevant resource). The SDK_OVERRIDES reader (EC2
// DescribeNetworkAcls, matched by RuleNumber + Egress) closes the gap. This fixture declares
// a NACL with a spread of entry shapes — TCP single port, TCP port range, all-protocols,
// ICMP, and an egress rule — so the read + field mapping (Protocol number-coercion, PortRange,
// Icmp, Egress) is exercised end to end. A freshly deployed + recorded NACL with NO out-of-band
// change MUST report CLEAN, and crucially the entries must be READ (not `skipped`).
import { App, Stack } from "aws-cdk-lib";
import {
  AclCidr,
  AclTraffic,
  Action,
  NetworkAcl,
  SubnetType,
  TrafficDirection,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegNaclEntry");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const nacl = new NetworkAcl(stack, "Nacl", {
  vpc,
  subnetSelection: { subnetType: SubnetType.PRIVATE_ISOLATED },
});

// TCP single port (Protocol 6, PortRange From==To).
nacl.addEntry("InHttps", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.tcpPort(443),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 100,
  ruleAction: Action.ALLOW,
});
// TCP port range (PortRange From!=To).
nacl.addEntry("InEphemeral", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.tcpPortRange(1024, 65535),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 110,
  ruleAction: Action.ALLOW,
});
// ICMP echo (Protocol 1, Icmp {Type, Code}).
nacl.addEntry("InIcmp", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.icmp({ type: 8, code: -1 }),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 120,
  ruleAction: Action.ALLOW,
});
// Explicit DENY (RuleAction allow vs deny — the security-relevant field).
nacl.addEntry("InDenySmtp", {
  cidr: AclCidr.ipv4("10.0.0.0/8"),
  traffic: AclTraffic.tcpPort(25),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 130,
  ruleAction: Action.DENY,
});
// Egress all-protocols (Protocol -1, Egress true, no PortRange).
nacl.addEntry("OutAll", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.allTraffic(),
  direction: TrafficDirection.EGRESS,
  ruleNumber: 100,
  ruleAction: Action.ALLOW,
});

app.synth();

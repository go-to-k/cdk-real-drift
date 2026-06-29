// CDK app for the cdk-real-drift SecurityGroup *protocol-rich* false-positive +
// detection integration test. The existing `securitygroup` fixture only exercises
// single-port TCP CIDR ingress; a huge fraction of real SGs also carry rule shapes
// whose live AWS form is textually different from the declared template:
//   - TCP / UDP PORT RANGES (FromPort != ToPort).
//   - ICMP rules (IpProtocol "icmp" with FromPort=type / ToPort=code, e.g. echo -1).
//   - IPv6 CIDR rules (CidrIpv6, which AWS may canonicalize) + an all-traffic egress.
//   - A PREFIX-LIST rule (SourcePrefixListId resolved from a customer-managed list).
//   - A SELF-REFERENCING rule (SourceSecurityGroupId == the SG's own GroupId via a
//     Fn::GetAtt intrinsic cdkrd must resolve).
// SecurityGroupIngress/SecurityGroupEgress are UNORDERED_OBJECT_ARRAY_PROPS — AWS may
// return the rules in a different order than declared. A freshly deployed + recorded SG
// with NO out-of-band change MUST report CLEAN; a normalizer/intrinsic regression turns
// one of these into a false declared drift.
// A minimal single-AZ VPC with no NAT keeps it cheap and self-cleaning.
import { App, Stack, Tags } from "aws-cdk-lib";
import { Peer, Port, PrefixList, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSgProto");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

// A customer-managed prefix list referenced from a rule below — self-contained, so the
// fixture needs no hardcoded region-specific AWS-managed prefix-list id.
const pl = new PrefixList(stack, "Pl", {
  maxEntries: 4,
  entries: [{ cidr: "10.5.0.0/16", description: "corp" }],
});

// allowAllOutbound:false + explicit egress rules below avoids CDK's dummy deny-all rule.
const sg = new SecurityGroup(stack, "Sg", { vpc, allowAllOutbound: false });

// TCP single port + TCP port range.
sg.addIngressRule(Peer.ipv4("10.0.0.0/24"), Port.tcp(443), "https");
sg.addIngressRule(Peer.ipv4("10.0.1.0/24"), Port.tcpRange(8000, 8100), "app range");
// UDP port range.
sg.addIngressRule(Peer.ipv4("10.0.2.0/24"), Port.udpRange(5000, 5010), "udp range");
// ICMP echo (ping): IpProtocol "icmp", FromPort=8, ToPort=-1.
sg.addIngressRule(Peer.ipv4("10.0.3.0/24"), Port.icmpPing(), "icmp ping");
// All ICMP: IpProtocol "icmp", FromPort=-1, ToPort=-1.
sg.addIngressRule(Peer.ipv4("10.0.4.0/24"), Port.allIcmp(), "icmp all");
// IPv6 ingress (CidrIpv6).
sg.addIngressRule(Peer.ipv6("2001:db8::/32"), Port.tcp(22), "ssh ipv6");
// Prefix-list ingress (SourcePrefixListId).
sg.addIngressRule(Peer.prefixList(pl.prefixListId), Port.tcp(3306), "mysql from prefix list");
// Self-referencing ingress (SourceSecurityGroupId == own GroupId).
sg.addIngressRule(sg, Port.tcp(9000), "self ref");

// Egress: a specific IPv6 rule (CidrIpv6 ::/0) + a specific IPv4 rule. (An IPv6
// all-traffic egress can only be expressed via allowAllIpv6Outbound, not addEgressRule.)
sg.addEgressRule(Peer.ipv6("::/0"), Port.tcp(443), "https out ipv6");
sg.addEgressRule(Peer.ipv4("0.0.0.0/0"), Port.tcp(443), "https out");

Tags.of(sg).add("team", "platform");

app.synth();

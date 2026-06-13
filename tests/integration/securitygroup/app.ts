// CDK app for the cdk-real-drift SecurityGroup false-positive integration test (R88).
// Tricky declared property: SecurityGroupIngress / SecurityGroupEgress — unordered
// arrays of rule objects (AWS may return them in a different order than declared)
// carrying CIDR strings. A minimal single-AZ VPC with no NAT keeps it cheap and
// self-cleaning.
import { App, Stack, Tags } from "aws-cdk-lib";
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSg");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc, allowAllOutbound: true });
sg.addIngressRule(Peer.ipv4("10.0.0.0/24"), Port.tcp(443), "https from a");
sg.addIngressRule(Peer.ipv4("10.0.1.0/24"), Port.tcp(443), "https from b");
sg.addIngressRule(Peer.ipv4("192.168.0.0/16"), Port.tcp(22), "ssh");
Tags.of(sg).add("team", "platform");

app.synth();

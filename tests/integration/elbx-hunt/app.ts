// CDK app for the cdk-real-drift elbx-hunt integration test (2026-08-09 hunt).
// One VPC-scoped pack over the ELB/VPC surfaces the offline audit flagged as
// genuinely unproven or zero-corpus:
//   - Gateway Load Balancer, barest — the ELB_ATTRIBUTE_DEFAULTS_BY_LB_TYPE
//     `gateway` row was mirrored from an NLB deploy and never proven live
//   - TargetGroup TCP_UDP x instance AND TCP_UDP x ip — the TCP_UDP
//     preserve_client_ip row was mirrored from the UDP deploy (#1664/#1680
//     cross-axis lesson: per-axis green proves nothing about intersections)
//   - AWS::ElasticLoadBalancingV2::TrustStoreRevocation (zero corpus; parent
//     TrustStore covered) — CA bundle + CRL pre-created by verify.sh, passed in
//     via CDKRD_HUNT_TSX_BUCKET (read on every synth)
//   - AWS::EC2::SubnetNetworkAclAssociation (zero corpus; default-NACL
//     association echo probe)
//   - NAT Gateway ConnectivityType=private (corpus has only public; the read has
//     no AllocationId/PublicIp)
//   - AWS::EC2::VPCEndpointService (NLB-backed) +
//     AWS::EC2::VPCEndpointConnectionNotification (zero corpus;
//     ConnectionEvents declared deliberately UNSORTED to probe set-reorder echo)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnNatGateway,
  CfnNetworkAcl,
  CfnSubnetNetworkAclAssociation,
  CfnVPCEndpointConnectionNotification,
  CfnVPCEndpointService,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnLoadBalancer,
  CfnTargetGroup,
  CfnTrustStore,
  CfnTrustStoreRevocation,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnTopic } from "aws-cdk-lib/aws-sns";

const tsBucket = process.env.CDKRD_HUNT_TSX_BUCKET;
if (!tsBucket) throw new Error("CDKRD_HUNT_TSX_BUCKET must be set (see verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0809ElbX");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  restrictDefaultSecurityGroup: false,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC }],
});
const [subnetA, subnetB] = vpc.publicSubnets;

// ── Gateway Load Balancer, barest (BY_LB_TYPE gateway row live proof) ──
new CfnLoadBalancer(stack, "Gwlb", {
  name: "cdkrd-hunt-0809-gwlb",
  type: "gateway",
  subnets: [subnetA.subnetId],
});

// ── internal NLB backing the endpoint service ──
const nlb = new CfnLoadBalancer(stack, "Nlb", {
  name: "cdkrd-hunt-0809-nlb",
  type: "network",
  scheme: "internal",
  subnets: [subnetA.subnetId],
});

// ── TCP_UDP x instance / TCP_UDP x ip target groups (mirrored-row crosses) ──
new CfnTargetGroup(stack, "TuInstTg", {
  name: "cdkrd-hunt-0809-tu-inst",
  protocol: "TCP_UDP",
  port: 53,
  vpcId: vpc.vpcId,
  targetType: "instance",
});
new CfnTargetGroup(stack, "TuIpTg", {
  name: "cdkrd-hunt-0809-tu-ip",
  protocol: "TCP_UDP",
  port: 53,
  vpcId: vpc.vpcId,
  targetType: "ip",
});

// ── private NAT gateway (no EIP surface at all) ──
new CfnNatGateway(stack, "PrivNat", {
  subnetId: subnetA.subnetId,
  connectivityType: "private",
});

// ── NACL + subnet association ──
const nacl = new CfnNetworkAcl(stack, "Nacl", { vpcId: vpc.vpcId });
new CfnSubnetNetworkAclAssociation(stack, "NaclAssoc", {
  networkAclId: nacl.ref,
  subnetId: subnetB.subnetId,
});

// ── VPC endpoint service + connection notification (events unsorted) ──
const vpces = new CfnVPCEndpointService(stack, "Vpces", {
  networkLoadBalancerArns: [nlb.ref],
  acceptanceRequired: false,
});
const ntopic = new CfnTopic(stack, "NotifTopic", {
  topicName: "cdkrd-hunt-0809-vpces-notif",
});
new CfnVPCEndpointConnectionNotification(stack, "VpcesNotif", {
  serviceId: vpces.ref,
  connectionNotificationArn: ntopic.ref,
  connectionEvents: ["Reject", "Accept", "Delete", "Connect"],
});

// ── trust store + revocation (CRL pre-created out of band) ──
const ts = new CfnTrustStore(stack, "TrustStore", {
  name: "cdkrd-hunt-0809-ts",
  caCertificatesBundleS3Bucket: tsBucket,
  caCertificatesBundleS3Key: "ca-bundle.pem",
});
new CfnTrustStoreRevocation(stack, "TsRevocation", {
  trustStoreArn: ts.attrTrustStoreArn,
  revocationContents: [{ s3Bucket: tsBucket, s3Key: "crl.pem" }],
});

app.synth();

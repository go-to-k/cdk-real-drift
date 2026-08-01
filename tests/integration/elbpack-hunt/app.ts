// ELBv2 pack first-run FP probe (2026-08-01 hunt):
// - dualstack ALB + dualstack NLB (no fixture has ever deployed IpAddressType
//   dualstack; the ipv6.deny_all_igw_traffic row in the shared LB-attribute
//   table cites a dualstack ALB deploy that was never harvested, and the NLB
//   arm is untested).
// - NLB TLS listener (the SslPolicy KNOWN_DEFAULTS row was mirrored from an
//   HTTPS/ALB listener deploy — "the same default applies to an NLB TLS
//   listener" was never live-proven; AlpnPolicy echo also unprobed).
// - mTLS: an HTTPS listener with MutualAuthentication verify + TrustStore
//   attached (the {Mode:'off'} whole-object fold was observed on a plain HTTPS
//   listener; the attached shape may materialize sibling leaves —
//   IgnoreClientCertificateExpiry etc. — the attachment-echo class).
// - barest Interface VPC endpoint (the only Interface-endpoint fixture declares
//   SecurityGroupIds/SubnetIds/PrivateDnsEnabled; undeclared → default-SG echo
//   + DnsOptions defaults).
// The ACM cert (self-signed, imported out of band) arrives via CDKRD_HUNT_CERT_ARN;
// the TrustStore CA bundle bucket via CDKRD_HUNT_TS_BUCKET (see verify.sh).
import { App, Fn, Stack, Tags } from "aws-cdk-lib";
import {
  CfnEgressOnlyInternetGateway,
  CfnInternetGateway,
  CfnRoute,
  CfnRouteTable,
  CfnSubnet,
  CfnSubnetRouteTableAssociation,
  CfnVPC,
  CfnVPCCidrBlock,
  CfnVPCEndpoint,
  CfnVPCGatewayAttachment,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnListener,
  CfnLoadBalancer,
  CfnTargetGroup,
  CfnTrustStore,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const certArn = process.env.CDKRD_HUNT_CERT_ARN;
const tsBucket = process.env.CDKRD_HUNT_TS_BUCKET;
if (!certArn || !tsBucket) {
  throw new Error("CDKRD_HUNT_CERT_ARN and CDKRD_HUNT_TS_BUCKET must be set (see verify.sh)");
}

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const s = new Stack(app, "CdkrdHunt0801Elb");

// Dualstack VPC: amazon-provided IPv6, two public subnets (ALB needs 2 AZs).
const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.65.0.0/16" });
const v6 = new CfnVPCCidrBlock(s, "V6", {
  vpcId: vpc.ref,
  amazonProvidedIpv6CidrBlock: true,
});
const igw = new CfnInternetGateway(s, "Igw");
const att = new CfnVPCGatewayAttachment(s, "IgwAtt", {
  vpcId: vpc.ref,
  internetGatewayId: igw.ref,
});
new CfnEgressOnlyInternetGateway(s, "Eigw", { vpcId: vpc.ref });
const rt = new CfnRouteTable(s, "Rt", { vpcId: vpc.ref });
const defRoute = new CfnRoute(s, "DefRoute", {
  routeTableId: rt.ref,
  destinationCidrBlock: "0.0.0.0/0",
  gatewayId: igw.ref,
});
defRoute.addDependency(att);
const v6Route = new CfnRoute(s, "V6Route", {
  routeTableId: rt.ref,
  destinationIpv6CidrBlock: "::/0",
  gatewayId: igw.ref,
});
v6Route.addDependency(att);

const v6cidrs = Fn.cidr(Fn.select(0, vpc.attrIpv6CidrBlocks), 2, "64");
const mkSubnet = (id: string, az: string, cidr: string, v6idx: number) => {
  const sn = new CfnSubnet(s, id, {
    vpcId: vpc.ref,
    availabilityZone: az,
    cidrBlock: cidr,
    ipv6CidrBlock: Fn.select(v6idx, v6cidrs),
    mapPublicIpOnLaunch: false,
  });
  sn.addDependency(v6);
  new CfnSubnetRouteTableAssociation(s, `${id}Assoc`, {
    subnetId: sn.ref,
    routeTableId: rt.ref,
  });
  return sn;
};
const sn1 = mkSubnet("Pub1", "us-east-1a", "10.65.0.0/24", 0);
const sn2 = mkSubnet("Pub2", "us-east-1b", "10.65.1.0/24", 1);

// TrustStore (CA bundle pre-created by verify.sh).
const ts = new CfnTrustStore(s, "Ts0801", {
  name: "cdkrd-hunt0801-mtls-ts",
  caCertificatesBundleS3Bucket: tsBucket,
  caCertificatesBundleS3Key: "ca-bundle.pem",
});

// Dualstack internet-facing ALB, SecurityGroups UNDECLARED (default-SG echo).
const alb = new CfnLoadBalancer(s, "DsAlb", {
  type: "application",
  scheme: "internet-facing",
  ipAddressType: "dualstack",
  subnets: [sn1.ref, sn2.ref],
});
// HTTPS listener with mTLS verify + attached TrustStore; fixed-response (no TG).
new CfnListener(s, "MtlsListener", {
  loadBalancerArn: alb.ref,
  protocol: "HTTPS",
  port: 443,
  certificates: [{ certificateArn: certArn }],
  mutualAuthentication: {
    mode: "verify",
    trustStoreArn: ts.attrTrustStoreArn,
  },
  defaultActions: [
    {
      type: "fixed-response",
      fixedResponseConfig: { statusCode: "200", contentType: "text/plain" },
    },
  ],
});

// Dualstack internet-facing NLB + TLS listener (mirrored SslPolicy row probe).
const nlb = new CfnLoadBalancer(s, "DsNlb", {
  type: "network",
  scheme: "internet-facing",
  ipAddressType: "dualstack",
  subnets: [sn1.ref, sn2.ref],
});
const tlsTg = new CfnTargetGroup(s, "NlbTlsTg", {
  protocol: "TLS",
  port: 443,
  targetType: "instance",
  vpcId: vpc.ref,
});
new CfnListener(s, "TlsListener", {
  loadBalancerArn: nlb.ref,
  protocol: "TLS",
  port: 443,
  certificates: [{ certificateArn: certArn }],
  defaultActions: [{ type: "forward", targetGroupArn: tlsTg.ref }],
});

// Barest Interface endpoint: only service + type + vpc + one subnet declared.
new CfnVPCEndpoint(s, "SqsIfEp", {
  vpcId: vpc.ref,
  serviceName: "com.amazonaws.us-east-1.sqs",
  vpcEndpointType: "Interface",
  subnetIds: [sn1.ref],
});

app.synth();

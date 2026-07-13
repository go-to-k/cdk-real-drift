// Barest-config ELBv2 ListenerCertificate fixture for the cdk-real-drift FP hunt.
// AWS::ElasticLoadBalancingV2::ListenerCertificate is a Cloud Control gap (the
// registry schema has NO handlers) → a `readElbv2ListenerCertificate` SDK_OVERRIDE
// added in #1560 that had ZERO corpus / fixture coverage (never run against a real
// listener). This exercises the reader's declared∩live projection: an internet-facing
// ALB with an HTTPS listener (default cert = one imported self-signed cert) plus a
// SECOND imported cert attached via CfnListenerCertificate. A clean deploy must
// FIRST-check CLEAN (the reader projects only the declared cert still present in the
// live non-default set), and removing the attached cert out of band must SURFACE as
// declared drift (verify-detect.sh). The default cert must be EXCLUDED from the model
// so it never FPs against the ListenerCertificate resource, which declares only the
// SNI (extra) cert. Both certs are imported out of band by verify.sh (self-signed, no
// ACM validation wait — the #1559/#1560 precedent) and passed via env.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnVPC, CfnSubnet, CfnInternetGateway, CfnVPCGatewayAttachment, CfnRouteTable, CfnRoute, CfnSubnetRouteTableAssociation, CfnSecurityGroup } from "aws-cdk-lib/aws-ec2";
import { CfnLoadBalancer, CfnListener, CfnListenerCertificate } from "aws-cdk-lib/aws-elasticloadbalancingv2";

const defaultCertArn = process.env.CDKRD_HUNT_DEFAULT_CERT_ARN;
const sniCertArn = process.env.CDKRD_HUNT_SNI_CERT_ARN;
if (!defaultCertArn || !sniCertArn) {
  throw new Error("CDKRD_HUNT_DEFAULT_CERT_ARN and CDKRD_HUNT_SNI_CERT_ARN must be set (see verify.sh)");
}
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntListenerCert0713", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});

// Minimal VPC with two public subnets in two AZs (an ALB requires >=2 AZs). No NAT.
const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.60.0.0/16" });
const igw = new CfnInternetGateway(stack, "Igw");
new CfnVPCGatewayAttachment(stack, "IgwAttach", { vpcId: vpc.ref, internetGatewayId: igw.ref });
const rt = new CfnRouteTable(stack, "PublicRt", { vpcId: vpc.ref });
new CfnRoute(stack, "PublicRoute", {
  routeTableId: rt.ref,
  destinationCidrBlock: "0.0.0.0/0",
  gatewayId: igw.ref,
});
const azs = [`${region}a`, `${region}b`];
const subnetRefs: string[] = [];
azs.forEach((az, i) => {
  const subnet = new CfnSubnet(stack, `PublicSubnet${i}`, {
    vpcId: vpc.ref,
    cidrBlock: `10.60.${i}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
  });
  new CfnSubnetRouteTableAssociation(stack, `PublicSubnetRta${i}`, {
    subnetId: subnet.ref,
    routeTableId: rt.ref,
  });
  subnetRefs.push(subnet.ref);
});

const sg = new CfnSecurityGroup(stack, "AlbSg", {
  groupDescription: "cdkrd hunt ALB sg",
  vpcId: vpc.ref,
  securityGroupIngress: [
    { ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0" },
  ],
});

const alb = new CfnLoadBalancer(stack, "Alb", {
  type: "application",
  scheme: "internet-facing",
  subnets: subnetRefs,
  securityGroups: [sg.attrGroupId],
});

// HTTPS listener: default cert declared inline; a fixed-response default action avoids
// needing a target group / targets (this fixture is only about the cert set).
const listener = new CfnListener(stack, "HttpsListener", {
  loadBalancerArn: alb.ref,
  port: 443,
  protocol: "HTTPS",
  certificates: [{ certificateArn: defaultCertArn }],
  defaultActions: [
    {
      type: "fixed-response",
      fixedResponseConfig: { statusCode: "200", contentType: "text/plain", messageBody: "ok" },
    },
  ],
});

// The resource under test: attach a SECOND (SNI) cert to the listener. The reader must
// project THIS cert (declared∩live) and exclude the listener's default cert.
new CfnListenerCertificate(stack, "SniCert", {
  listenerArn: listener.ref,
  certificates: [{ certificateArn: sniCertArn }],
});

app.synth();

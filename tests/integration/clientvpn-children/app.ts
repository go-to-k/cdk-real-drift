// Barest-config ClientVPN CHILD-resource fixture for the cdk-real-drift FP hunt.
// AWS::EC2::ClientVpnAuthorizationRule and AWS::EC2::ClientVpnTargetNetworkAssociation
// are NON_PROVISIONABLE CC gaps whose SDK_OVERRIDES readers (issue #534) had ZERO
// corpus cases and ZERO fixtures — they were added without ever being exercised
// live. This fixture deploys the smallest stack that materializes BOTH children:
// a VPC + one subnet + a cert-auth endpoint (same self-signed ACM import trick as
// clientvpn-barest, via CDKRD_HUNT_VPN_CERT_ARN) + one target-network association
// + one authorize-all rule. First check (before record) MUST be CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnClientVpnAuthorizationRule,
  CfnClientVpnEndpoint,
  CfnClientVpnTargetNetworkAssociation,
  CfnSubnet,
  CfnVPC,
} from "aws-cdk-lib/aws-ec2";

const certArn = process.env.CDKRD_HUNT_VPN_CERT_ARN;
if (!certArn) throw new Error("CDKRD_HUNT_VPN_CERT_ARN must be set (see verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntCvpnKids0713");

const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.42.0.0/16" });
const subnet = new CfnSubnet(stack, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.42.0.0/24",
});

const endpoint = new CfnClientVpnEndpoint(stack, "Endpoint", {
  clientCidrBlock: "10.100.0.0/22", // must not overlap the target VPC
  serverCertificateArn: certArn,
  authenticationOptions: [
    {
      type: "certificate-authentication",
      mutualAuthentication: { clientRootCertificateChainArn: certArn },
    },
  ],
  connectionLogOptions: { enabled: false },
});

new CfnClientVpnTargetNetworkAssociation(stack, "Assoc", {
  clientVpnEndpointId: endpoint.ref,
  subnetId: subnet.ref,
});

new CfnClientVpnAuthorizationRule(stack, "Rule", {
  clientVpnEndpointId: endpoint.ref,
  targetNetworkCidr: "10.42.0.0/16",
  authorizeAllGroups: true,
});

app.synth();

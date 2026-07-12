// Barest-config EC2 ClientVpnEndpoint fixture for the cdk-real-drift FP hunt.
// AWS::EC2::ClientVpnEndpoint is a Cloud Control gap (NON_PROVISIONABLE, no
// read handler) with a `readEc2ClientVpnEndpoint` SDK_OVERRIDE that was added
// without ever being exercised live. The server certificate must exist in ACM
// BEFORE the stack deploys, so verify.sh imports a self-signed cert out of
// band and passes its ARN via CDKRD_HUNT_VPN_CERT_ARN (env is set for deploy
// AND for every cdkrd invocation, which re-synthesizes this app). Mutual
// (certificate) auth reuses the same self-signed cert as the client root
// chain, avoiding any directory/SAML dependency. No target-network
// association is declared: an unassociated endpoint is free and the endpoint
// read alone is what this fixture exercises.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnClientVpnEndpoint } from "aws-cdk-lib/aws-ec2";

const certArn = process.env.CDKRD_HUNT_VPN_CERT_ARN;
if (!certArn) throw new Error("CDKRD_HUNT_VPN_CERT_ARN must be set (see verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntClientVpn0712c");

// Barest endpoint: only what CFn requires.
new CfnClientVpnEndpoint(stack, "Endpoint", {
  clientCidrBlock: "10.100.0.0/22",
  serverCertificateArn: certArn,
  authenticationOptions: [
    {
      type: "certificate-authentication",
      mutualAuthentication: { clientRootCertificateChainArn: certArn },
    },
  ],
  connectionLogOptions: { enabled: false },
});

app.synth();

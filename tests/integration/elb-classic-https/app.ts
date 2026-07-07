// CDK app for the cdk-real-drift elb-classic-https integration test. A follow-up to
// elb-classic-rich (#604) covering the UNEXERCISED classic-ELB angle: an
// INTERNET-FACING LoadBalancer with an HTTPS listener. An HTTPS/SSL listener makes
// AWS auto-assign a default SSL negotiation `Policies` entry (an
// `ELBSecurityPolicy-*` reference security policy) that the template never declares —
// a fresh undeclared-fill class the internal HTTP-only #604 fixture could not surface.
// Per the core invariant a clean deploy must produce ZERO [Potential Drift] on a first
// `check`. The HTTPS listener needs a server certificate; the verify script uploads a
// self-signed IAM server certificate and passes its ARN via `-c certArn=...`.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  LoadBalancer,
  LoadBalancingProtocol,
} from "aws-cdk-lib/aws-elasticloadbalancing";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbClassicHttps");

const certArn = stack.node.tryGetContext("certArn");
if (!certArn) throw new Error("pass -c certArn=<iam-server-cert-arn>");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "pub", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

// Internet-facing CLB with an HTTPS listener. Only the listener + cert are declared;
// AWS's auto-assigned SSL negotiation Policies, ConnectionSettings, and
// ConnectionDrainingPolicy are left undeclared so a first `check` surfaces any fill.
const lb = new LoadBalancer(stack, "Clb", {
  vpc,
  internetFacing: true,
  healthCheck: { port: 80 },
});

lb.addListener({
  externalPort: 443,
  externalProtocol: LoadBalancingProtocol.HTTPS,
  internalPort: 80,
  internalProtocol: LoadBalancingProtocol.HTTP,
  sslCertificateArn: certArn,
});

app.synth();

// Barest-config Cloud Map PRIVATE DNS namespace fixture for the cdk-real-drift FP
// hunt. AWS::ServiceDiscovery::PrivateDnsNamespace shares readServiceDiscoveryNamespace
// with the Http/Public variants, but the PRIVATE variant had ZERO corpus cases and
// ZERO fixtures — its live shape (a DNS namespace carries a Vpc / hosted-zone side)
// was never exercised. Uses the L2 constructs (the common user path): an L2
// PrivateDnsNamespace over a minimal imported VPC + one L2-created DNS service
// (exercises the #1537 DnsConfig.NamespaceId mirror on a PRIVATE namespace).
// First check (before record) MUST be CLEAN.
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import { CfnVPC, Vpc } from "aws-cdk-lib/aws-ec2";
import { DnsRecordType, PrivateDnsNamespace } from "aws-cdk-lib/aws-servicediscovery";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntCmapPriv0713");

// Minimal VPC: the raw Cfn resource (no subnets/NAT), re-imported for the L2 API.
const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.43.0.0/16" });
const vpcRef = Vpc.fromVpcAttributes(stack, "VpcRef", {
  vpcId: vpc.ref,
  availabilityZones: ["dummy"], // unused by the namespace; required by the importer
});

const ns = new PrivateDnsNamespace(stack, "Ns", {
  name: "cdkrd-hunt-priv.internal",
  vpc: vpcRef,
});

ns.createService("Svc", {
  name: "hunt-svc",
  dnsRecordType: DnsRecordType.A,
  dnsTtl: Duration.seconds(60),
});

app.synth();

// CDK app for the cdk-real-drift Transit Gateway false-positive test. A Transit
// Gateway is the common hub for multi-VPC / hybrid connectivity, and
// AWS::EC2::TransitGateway has not been exercised. It is interesting for the FP
// hunt because almost all of its properties are string-valued enum toggles
// (`enable`/`disable`) with service-applied defaults — exactly the
// KNOWN_DEFAULTS / enum-normalization surface that produced false positives on
// other types. This fixture declares a few explicitly and leaves the rest to
// default. A freshly deployed + recorded TGW with NO out-of-band change MUST
// report CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnTransitGateway } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegTransitGatewayRich");

const tgw = new CfnTransitGateway(stack, "Tgw", {
  amazonSideAsn: 64512,
  description: "cdk-real-drift integ transit gateway",
  autoAcceptSharedAttachments: "disable",
  defaultRouteTableAssociation: "enable",
  defaultRouteTablePropagation: "enable",
  dnsSupport: "enable",
  vpnEcmpSupport: "enable",
  multicastSupport: "disable",
});

Tags.of(tgw).add("team", "network");

app.synth();

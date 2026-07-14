// Sibling-attachment echo probe batch 2 (the #1574 clientvpn-assoc class): deploy
// parents WITH attachment-style siblings and first-check that shape — an echo the
// parent-alone fixture can never materialize. Pairs not in attach-echo-hunt:
// - EC2::TransitGateway + TransitGatewayAttachment (the attachment type itself is
//   also corpus-uncovered) — does attaching materialize undeclared props on the
//   TGW or the VPC?
// - Two VPCs + VPCPeeringConnection — does an active peering materialize on
//   either VPC read?
// - SES::ConfigurationSet + ConfigurationSetEventDestination (the event
//   destination type is corpus-uncovered; CW-dimension destination).
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnSubnet,
  CfnTransitGateway,
  CfnTransitGatewayAttachment,
  CfnVPC,
  CfnVPCPeeringConnection,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnConfigurationSet,
  CfnConfigurationSetEventDestination,
} from "aws-cdk-lib/aws-ses";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0715Attach2");

const vpcA = new CfnVPC(s, "VpcA", { cidrBlock: "10.2.0.0/24" });
const vpcB = new CfnVPC(s, "VpcB", { cidrBlock: "10.3.0.0/24" });
const subnetA = new CfnSubnet(s, "SubnetA", {
  vpcId: vpcA.ref,
  cidrBlock: "10.2.0.0/25",
  availabilityZone: "us-east-1a",
});

const tgw = new CfnTransitGateway(s, "Tgw", {});
new CfnTransitGatewayAttachment(s, "TgwAttach", {
  transitGatewayId: tgw.ref,
  vpcId: vpcA.ref,
  subnetIds: [subnetA.ref],
});

new CfnVPCPeeringConnection(s, "Peering", {
  vpcId: vpcA.ref,
  peerVpcId: vpcB.ref,
});

const cs = new CfnConfigurationSet(s, "ConfigSet", {
  name: "cdkrd-hunt-0715-cs",
});
new CfnConfigurationSetEventDestination(s, "CsEventDest", {
  configurationSetName: cs.ref,
  eventDestination: {
    matchingEventTypes: ["send", "bounce", "complaint"],
    cloudWatchDestination: {
      dimensionConfigurations: [
        {
          dimensionName: "cdkrd",
          dimensionValueSource: "messageTag",
          defaultDimensionValue: "none",
        },
      ],
    },
  },
});

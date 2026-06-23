// cdk-real-drift Transit Gateway route-table read-gap test.
// AWS::EC2::TransitGatewayRouteTableAssociation / ::TransitGatewayRoute /
// ::TransitGatewayRouteTablePropagation all have a 2-segment COMPOSITE
// primaryIdentifier (TransitGatewayRouteTableId + TransitGatewayAttachmentId, or
// + DestinationCidrBlock) whose CFn physical id (Ref) is an opaque association/route
// id — NOT the composite — so Cloud Control GetResource rejects it (ValidationException)
// and the resource is silently `skipped` (read-gap). Both composite segments are
// declared props, so an adapter can build the composite from the resolved declared Refs.
// After the CC_IDENTIFIER_ADAPTERS fix the resources read, so a fresh deploy + record +
// check is CLEAN with no skipped resources. A small VPC (no NAT) keeps it self-contained.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnTransitGateway,
  CfnTransitGatewayRoute,
  CfnTransitGatewayRouteTable,
  CfnTransitGatewayRouteTableAssociation,
  CfnTransitGatewayRouteTablePropagation,
  CfnTransitGatewayVpcAttachment,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegTgwRouteTableReadGap");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const tgw = new CfnTransitGateway(stack, "Tgw", {
  // Disable the default association/propagation so our custom route table owns it.
  defaultRouteTableAssociation: "disable",
  defaultRouteTablePropagation: "disable",
});

const attachment = new CfnTransitGatewayVpcAttachment(stack, "Attachment", {
  transitGatewayId: tgw.ref,
  vpcId: vpc.vpcId,
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
});

const routeTable = new CfnTransitGatewayRouteTable(stack, "RouteTable", {
  transitGatewayId: tgw.ref,
});

new CfnTransitGatewayRouteTableAssociation(stack, "Association", {
  transitGatewayRouteTableId: routeTable.ref,
  transitGatewayAttachmentId: attachment.ref,
});

new CfnTransitGatewayRouteTablePropagation(stack, "Propagation", {
  transitGatewayRouteTableId: routeTable.ref,
  transitGatewayAttachmentId: attachment.ref,
});

new CfnTransitGatewayRoute(stack, "Route", {
  transitGatewayRouteTableId: routeTable.ref,
  destinationCidrBlock: "10.99.0.0/16",
  transitGatewayAttachmentId: attachment.ref,
});

app.synth();

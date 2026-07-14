// VPC Lattice family gap probe: the corpus covers ServiceNetwork / Service /
// Listener / Rule / TargetGroup / ServiceNetworkServiceAssociation, but NOT
// AuthPolicy, AccessLogSubscription, ServiceNetworkVpcAssociation,
// ResourceGateway, or ResourceConfiguration (all CC-readable, single
// primaryIdentifier — probed via describe-type). This is simultaneously a
// sibling-ATTACHMENT echo probe: the barest ServiceNetwork deployed ALONE is
// covered, so deploy it here WITH an auth policy + log subscription + VPC
// association attached and first-check that shape (the clientvpn-assoc echo
// class, #1574).
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import {
  CfnAccessLogSubscription,
  CfnAuthPolicy,
  CfnResourceConfiguration,
  CfnResourceGateway,
  CfnServiceNetwork,
  CfnServiceNetworkVpcAssociation,
} from "aws-cdk-lib/aws-vpclattice";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0715Lattice");

const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.0.0.0/24" });
const subnet = new CfnSubnet(s, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.0.0/24",
  availabilityZone: "us-east-1a",
});

// Barest service network (Name undeclared → auto-generated) with three
// attachments: auth policy (inactive on a NONE-auth network — the read echo is
// the probe), access log subscription, and a VPC association.
const sn = new CfnServiceNetwork(s, "Sn", {});

new CfnAuthPolicy(s, "SnAuthPolicy", {
  resourceIdentifier: sn.ref,
  policy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: "vpc-lattice-svcs:Invoke",
        Resource: "*",
      },
    ],
  },
});

const lg = new CfnLogGroup(s, "SnLogs", {});

new CfnAccessLogSubscription(s, "SnAls", {
  resourceIdentifier: sn.ref,
  destinationArn: lg.attrArn,
});

new CfnServiceNetworkVpcAssociation(s, "SnVpcAssoc", {
  serviceNetworkIdentifier: sn.ref,
  vpcIdentifier: vpc.ref,
});

const rg = new CfnResourceGateway(s, "Rg", {
  name: "cdkrd-hunt-0715-rg",
  vpcIdentifier: vpc.ref,
  subnetIds: [subnet.ref],
});

new CfnResourceConfiguration(s, "Rc", {
  name: "cdkrd-hunt-0715-rc",
  resourceConfigurationType: "SINGLE",
  resourceGatewayId: rg.attrId,
  protocolType: "TCP",
  portRanges: ["80"],
  resourceConfigurationDefinition: {
    ipResource: "10.0.0.10",
  },
});

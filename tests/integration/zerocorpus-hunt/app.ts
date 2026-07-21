// Zero-corpus cheap-tail probe: the three remaining common-ish types with no
// corpus case at all — EC2 CapacityReservation (billed as a running t3.nano only
// while the stack is up), Route 53 Profiles Profile + ProfileAssociation (the
// association doubles as an attachment-shape probe on the VPC), and EC2
// NetworkInsightsPath (free; only an ANALYSIS run costs). First check before
// record MUST be CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnCapacityReservation,
  CfnNetworkInsightsPath,
  CfnNetworkInterface,
  CfnSubnet,
  CfnVPC,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnProfile,
  CfnProfileAssociation,
} from "aws-cdk-lib/aws-route53profiles";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");

const s = new Stack(app, "CdkrdHunt0721Zc");

new CfnCapacityReservation(s, "Cr", {
  availabilityZone: "us-east-1a",
  instanceType: "t3.nano",
  instancePlatform: "Linux/UNIX",
  instanceCount: 1,
});

const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.73.0.0/16" });
const sub = new CfnSubnet(s, "Sub", {
  vpcId: vpc.ref,
  cidrBlock: "10.73.0.0/24",
  availabilityZone: "us-east-1a",
});

const profile = new CfnProfile(s, "Profile", { name: "cdkrd-hunt0721-profile" });
new CfnProfileAssociation(s, "ProfileAssoc", {
  name: "cdkrd-hunt0721-assoc",
  profileId: profile.attrId,
  resourceId: vpc.ref,
});

const eniA = new CfnNetworkInterface(s, "EniA", { subnetId: sub.ref });
const eniB = new CfnNetworkInterface(s, "EniB", { subnetId: sub.ref });
new CfnNetworkInsightsPath(s, "NiPath", {
  source: eniA.ref,
  destination: eniB.ref,
  protocol: "tcp",
});

app.synth();

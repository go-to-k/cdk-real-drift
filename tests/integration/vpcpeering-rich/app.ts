// CDK app for the cdk-real-drift VPC peering false-positive test. A
// VPCPeeringConnection between two same-account same-region VPCs is a common
// multi-VPC primitive. Cheap (no NAT/IGW). A freshly deployed + recorded peering
// with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnVPC, CfnVPCPeeringConnection } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegVpcPeering");

const vpcA = new CfnVPC(stack, "VpcA", { cidrBlock: "10.71.0.0/16" });
const vpcB = new CfnVPC(stack, "VpcB", { cidrBlock: "10.72.0.0/16" });

new CfnVPCPeeringConnection(stack, "Peering", {
  vpcId: vpcA.ref,
  peerVpcId: vpcB.ref,
});

app.synth();

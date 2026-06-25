// Minimal CDK app for the cdk-real-drift `added` integ test on EC2 (the TENTH
// CHILD_ENUMERATORS member). A minimal VPC (one AZ, one public subnet, no NAT) so
// teardown is fast and cheap. verify.sh then `create-subnet`s additional subnets in the
// SAME VPC out of band (via the AWS CLI) — whole Subnet resources not in the template —
// and asserts cdkrd reports them under [Potential Drift] (PR4: an unrecorded added resource
// is inventory, not drift), records + watches them, and can revert (delete) them.
//
// The VPC's default CIDR is 10.0.0.0/16. The out-of-band subnets verify.sh injects sit in
// UNUSED /24s within that block (10.0.200.0/24 / 10.0.201.0/24) so they do not collide
// with the CDK-allocated public subnet. An out-of-band subnet that lingers in the VPC
// BLOCKS the VPC's deletion (CFn cannot delete a VPC that still has subnets), so verify.sh
// sweeps any injected subnets off the VPC BEFORE delstack (see its cleanup trap).
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegEc2SubnetAdded");

new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "p", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
}); // the declared subnet(s) — must NOT flag

app.synth();

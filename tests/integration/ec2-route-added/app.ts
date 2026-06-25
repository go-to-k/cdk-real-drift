// Minimal CDK app for the cdk-real-drift `added` integ test on EC2 route tables (the
// ELEVENTH CHILD_ENUMERATORS member). A minimal VPC (one AZ, no NAT) with ONE PUBLIC
// subnet so CDK auto-creates an InternetGateway and a route table whose public route
// `0.0.0.0/0 -> IGW` is a DECLARED AWS::EC2::Route in the template. The public route
// table also carries the auto-created VPC-local route (Origin=CreateRouteTable /
// GatewayId=local), which is NOT a declared AWS::EC2::Route — the enumerator must SKIP it.
//
// verify.sh then `create-route`s additional routes (10.99.0.0/16, 10.98.0.0/16) into the
// SAME public route table out of band (via the AWS CLI) — whole Route resources not in
// the template — and asserts cdkrd reports them under [Potential Drift] (PR4: an unrecorded
// added resource is inventory, not drift) WITHOUT flagging the declared 0.0.0.0/0 route or
// the VPC-local route, records + watches them, and can revert (delete) them. Deleting the
// route table (with the VPC) removes its routes, so an out-of-band route does NOT block
// teardown.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegEc2RouteAdded");

new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "p", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
}); // the public subnet's RT has: local route (skipped) + a declared 0.0.0.0/0 -> IGW route

app.synth();

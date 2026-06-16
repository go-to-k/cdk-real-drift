// Minimal CDK app for the cdk-real-drift `added` integ test on Elastic Load Balancing v2
// (the EIGHTH CHILD_ENUMERATORS member). An internal Application Load Balancer with ONE
// declared Listener. verify.sh then `create-listener`s additional listeners on the SAME
// load balancer out of band (via the AWS CLI) — whole Listener resources not in the
// template — and asserts cdkrd reports them under [Not Recorded] (PR4: an unrecorded
// added resource is inventory, not drift), records + watches them, and can revert
// (delete) them.
//
// The declared listener uses a FIXED-RESPONSE default action so no target group is
// needed, keeping the fixture light; the out-of-band listeners verify.sh injects are
// likewise fixed-response so Cloud Control DeleteResource removes them cleanly. The ALB
// and its VPC are stack resources, so delstack tears them and their listeners down (an
// ALB's listeners cascade on delete) — no stack-external orphans. natGateways:0 keeps
// the VPC cheap; an internal ALB needs no NAT.
import { App, Stack } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegElbv2ListenerAdded");

const vpc = new Vpc(stack, "Vpc", { maxAzs: 2, natGateways: 0 });
const alb = new ApplicationLoadBalancer(stack, "Alb", { vpc, internetFacing: false });

alb.addListener("DeclaredListener", {
  port: 80,
  protocol: ApplicationProtocol.HTTP,
  defaultAction: ListenerAction.fixedResponse(200, {
    contentType: "text/plain",
    messageBody: "ok",
  }),
}); // declared listener — must NOT flag

app.synth();

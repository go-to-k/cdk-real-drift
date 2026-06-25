// Minimal CDK app for the cdk-real-drift `added` integ test on Elastic Load Balancing v2
// LISTENER RULES (the FIFTEENTH CHILD_ENUMERATORS member). An internal Application Load
// Balancer with ONE Listener and ONE declared ListenerRule. The Listener is itself a
// declared template resource AND is enumerated as a child of its LoadBalancer, but it can
// ALSO be a parent here — its declared ListenerRule must NOT flag. verify.sh then
// `create-rule`s additional rules on the SAME listener out of band (via the AWS CLI) —
// whole ListenerRule resources not in the template — and asserts cdkrd reports them under
// [Potential Drift] (PR4: an unrecorded added resource is inventory, not drift), records +
// watches them, and can revert (delete) them. The listener's auto-created DEFAULT rule
// (`IsDefault`) must NOT flag.
//
// The listener uses a FIXED-RESPONSE default action and the declared rule a fixed-response
// action so no target group is needed, keeping the fixture light; the out-of-band rules
// verify.sh injects are likewise fixed-response so Cloud Control DeleteResource removes
// them cleanly. The ALB and its VPC are stack resources, so delstack tears them and their
// listeners + rules down (an ALB's listeners/rules cascade on delete) — no stack-external
// orphans. natGateways:0 keeps the VPC cheap; an internal ALB needs no NAT.
import { App, Stack } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegElbv2ListenerRuleAdded");

const vpc = new Vpc(stack, "Vpc", { maxAzs: 2, natGateways: 0 });
const alb = new ApplicationLoadBalancer(stack, "Alb", { vpc, internetFacing: false });

const listener = alb.addListener("L", {
  port: 80,
  protocol: ApplicationProtocol.HTTP,
  defaultAction: ListenerAction.fixedResponse(200, {
    contentType: "text/plain",
    messageBody: "ok",
  }),
});

listener.addAction("DeclaredRule", {
  priority: 10,
  conditions: [ListenerCondition.pathPatterns(["/declared"])],
  action: ListenerAction.fixedResponse(200, { messageBody: "d" }),
}); // declared listener rule — must NOT flag

app.synth();

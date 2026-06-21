// CDK app for the cdk-real-drift ALB listener-rule false-positive test. A declared
// AWS::ElasticLoadBalancingV2::ListenerRule with multiple conditions is a very
// common routing pattern, but only the out-of-band `added`-tier path has been
// exercised (elbv2-listenerrule-added). Its CC primaryIdentifier is the single
// RuleArn (read directly, no adapter), so the interesting surface is the nested
// Conditions array — each condition carries its own values array (PathPatternConfig,
// HostHeaderConfig, HttpHeaderConfig) that AWS may return reordered or enriched with
// the legacy `Values` mirror. A freshly deployed + recorded rule with NO out-of-band
// change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationListenerRule,
  ApplicationLoadBalancer,
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbv2ListenerRuleRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const alb = new ApplicationLoadBalancer(stack, "Alb", { vpc, internetFacing: false });

const listener = alb.addListener("Listener", {
  port: 80,
  defaultAction: ListenerAction.fixedResponse(404, { contentType: "text/plain", messageBody: "nf" }),
});

new ApplicationListenerRule(stack, "Rule", {
  listener,
  priority: 10,
  // AWS caps a rule at 5 condition values total (across all conditions).
  conditions: [
    ListenerCondition.pathPatterns(["/api/*", "/v2/*"]),
    ListenerCondition.hostHeaders(["example.com", "www.example.com"]),
    ListenerCondition.httpHeader("X-Custom", ["a"]),
  ],
  action: ListenerAction.fixedResponse(200, { contentType: "text/plain", messageBody: "ok" }),
});

app.synth();

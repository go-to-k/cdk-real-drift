// CDK app for the cdk-real-drift ALB ListenerRule nested-VALUES-set FP test. The
// existing elbv2-listenerrule-rich fixture proved the top-level Conditions array is
// folded (UNORDERED_OBJECT_ARRAY_PROPS), but it declared each condition's `Values`
// already in sorted order ("/api/*" < "/v2/*", "example.com" < "www.example.com"),
// so it could NOT reveal whether ALB reorders the SCALAR string set nested INSIDE
// each condition's *Config. This fixture declares those Values in DELIBERATELY
// non-sorted order — within the 5-values-per-rule cap — so if ALB canonicalizes the
// set, a positional compare false-flags declared drift on every shifted value of a
// freshly deployed + recorded rule. ListenerRule routing (path/host conditions) is a
// very common pattern. Within one condition, multiple values are OR'd, so order is
// NOT semantic — a genuine set.
//
// Secondary probe (shared ALB infra): the rule's action is a weighted-forward to two
// target groups declared in non-canonical order, to check whether ALB reorders the
// identity-less {TargetGroupArn,Weight} set nested under Actions[].ForwardConfig.
// A freshly deployed + recorded stack MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationListenerRule,
  ApplicationLoadBalancer,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbv2RuleValues");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const alb = new ApplicationLoadBalancer(stack, "Alb", { vpc, internetFacing: false });

const listener = alb.addListener("Listener", {
  port: 80,
  defaultAction: ListenerAction.fixedResponse(404, {
    contentType: "text/plain",
    messageBody: "nf",
  }),
});

// Two empty (no-target) target groups for the weighted-forward probe.
const tgA = new ApplicationTargetGroup(stack, "TgA", {
  vpc,
  port: 80,
  targetType: TargetType.IP,
});
const tgB = new ApplicationTargetGroup(stack, "TgB", {
  vpc,
  port: 80,
  targetType: TargetType.IP,
});

new ApplicationListenerRule(stack, "Rule", {
  listener,
  priority: 10,
  // Values declared NON-alphabetically; 3 + 2 = 5 (the per-rule cap).
  conditions: [
    ListenerCondition.pathPatterns(["/zebra/*", "/alpha/*", "/mango/*"]),
    ListenerCondition.hostHeaders(["zzz.example.com", "aaa.example.com"]),
  ],
  // Weighted-forward to two target groups, declared B-before-A.
  action: ListenerAction.weightedForward([
    { targetGroup: tgB, weight: 20 },
    { targetGroup: tgA, weight: 10 },
  ]),
});

app.synth();

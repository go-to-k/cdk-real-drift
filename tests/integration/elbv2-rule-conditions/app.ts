// CDK app for the cdk-real-drift ALB ListenerRule nested-condition-VALUES FP test.
// The existing elbv2-rule-values fixture covered PathPatternConfig.Values (folded)
// and HostHeaderConfig.Values (observed order-PRESERVING). This fixture probes the
// REMAINING condition-value sets the CFn schema marks insertionOrder:false, each on
// its own rule, declared in DELIBERATELY non-sorted order:
//
//   SourceIpConfig.Values            — scalar CIDR set (not id/ARN-shaped → not auto-folded)
//   HttpHeaderConfig.Values          — scalar header-value-string set
//   QueryStringConfig.Values         — object set {Key,Value} (Key ∉ IDENTITY_FIELDS)
//   HttpRequestMethodConfig.Values   — scalar HTTP-verb set (auto-folded by isHttpMethod → control)
//
// If ALB canonicalizes any of these, a positional compare false-flags declared drift
// on every shifted value of a freshly recorded rule. ListenerRule routing is a very
// common pattern. The ALB is internal (no public IP) in a NAT-free VPC, so it is
// cheap and tears down fast. A freshly deployed + recorded stack MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationListenerRule,
  ApplicationLoadBalancer,
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbv2RuleConditions");

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

const respond = ListenerAction.fixedResponse(200, { contentType: "text/plain", messageBody: "ok" });

// Rule 1 — SourceIp CIDR set declared non-sorted.
new ApplicationListenerRule(stack, "RuleSourceIp", {
  listener,
  priority: 10,
  conditions: [ListenerCondition.sourceIps(["10.3.0.0/16", "10.1.0.0/16", "10.2.0.0/16"])],
  action: respond,
});

// Rule 2 — HttpHeader value set declared non-sorted.
new ApplicationListenerRule(stack, "RuleHttpHeader", {
  listener,
  priority: 20,
  conditions: [ListenerCondition.httpHeader("X-Cdkrd", ["zeta", "alpha", "mike"])],
  action: respond,
});

// Rule 3 — QueryString {Key,Value} object set declared non-sorted by Key.
new ApplicationListenerRule(stack, "RuleQueryString", {
  listener,
  priority: 30,
  conditions: [
    ListenerCondition.queryStrings([
      { key: "zeta", value: "1" },
      { key: "alpha", value: "2" },
      { key: "mike", value: "3" },
    ]),
  ],
  action: respond,
});

// Rule 4 — HttpRequestMethod verb set declared non-sorted (control: auto-folded as HTTP methods).
new ApplicationListenerRule(stack, "RuleMethod", {
  listener,
  priority: 40,
  conditions: [ListenerCondition.httpRequestMethods(["POST", "GET", "DELETE"])],
  action: respond,
});

app.synth();

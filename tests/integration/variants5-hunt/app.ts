// Barest-variant first-run FP probe batch 5 (real AWS) — the two remaining cheap
// axes from the 2026-07-17 variants audit:
// - WAFv2::WebACL Scope CLOUDFRONT: every existing WAFv2 fixture is REGIONAL; the
//   CLOUDFRONT scope lives on the global endpoint (us-east-1) and its echoes /
//   read routing were never exercised.
// - ELBv2::TargetGroup UDP / TLS / TCP_UDP protocols: TCP/HTTP/GENEVE/lambda are
//   covered; the NLB protocol variants carry different health-check defaults
//   (register-only — no load balancer needed, free).
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0717Variants5");

// CLOUDFRONT-scope barest ACL — no Rules, no Name.
new CfnWebACL(s, "CfAcl", {
  scope: "CLOUDFRONT",
  defaultAction: { allow: {} },
  visibilityConfig: {
    sampledRequestsEnabled: false,
    cloudWatchMetricsEnabled: false,
    metricName: "cdkrdHunt0717CfAcl",
  },
});

const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.62.0.0/16" });

// NLB protocol variants, barest: only Protocol/Port/VpcId declared — health-check
// defaults (protocol/port/interval/threshold) are the probe surface.
new CfnTargetGroup(s, "UdpTg", {
  protocol: "UDP",
  port: 53,
  vpcId: vpc.ref,
});
new CfnTargetGroup(s, "TlsTg", {
  protocol: "TLS",
  port: 443,
  vpcId: vpc.ref,
});
new CfnTargetGroup(s, "TcpUdpTg", {
  protocol: "TCP_UDP",
  port: 53,
  vpcId: vpc.ref,
});

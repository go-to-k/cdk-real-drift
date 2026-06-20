// CDK app for the cdk-real-drift WAFv2 WebACL false-positive test. A regional
// WebACL is a daily-deployed protection for ALB/API Gateway/AppSync. It packs the
// FP-prone surfaces: a managed rule group statement (AWS managed rules), a
// rate-based rule, per-rule + top-level VisibilityConfig, and a defaultAction —
// nested structures WAFv2 default-fills and re-serializes server-side. A freshly
// deployed + recorded WebACL with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2Rich");

new CfnWebACL(stack, "WebAcl", {
  name: "cdkrd-wafv2-rich",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdWebAcl",
  },
  rules: [
    {
      name: "AWSCommon",
      priority: 1,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesCommonRuleSet",
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "AWSCommon",
      },
    },
    {
      name: "RateLimit",
      priority: 2,
      action: { block: {} },
      statement: {
        rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "RateLimit",
      },
    },
  ],
});

app.synth();

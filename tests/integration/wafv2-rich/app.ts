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
  // Rules are declared in REVERSE Name order (RateLimit before AWSCommon) AND with
  // priorities matching the array order, NOT the Name order — so the live WebACL's rule
  // order ([RateLimit, AWSCommon], however AWS returns it) differs from cdkrd's canonical
  // Name-sorted order ([AWSCommon, RateLimit]). This exercises the revert index-alignment
  // fix: a per-rule drift finding is indexed in the SORTED space, so the SDK writer must
  // canonicalize the live model before applying the patch or it lands on the WRONG rule
  // (see verify-detect-ruleorder.sh).
  rules: [
    {
      name: "RateLimit",
      priority: 1,
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
    {
      name: "AWSCommon",
      priority: 2,
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
  ],
});

app.synth();

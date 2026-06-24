// CDK app for the cdk-real-drift WAFv2 WebACL Rules-reorder false-positive test.
// The existing wafv2-webacl-rich fixture always declares its Rules in ascending
// Priority order, so it never exercises a TOP-LEVEL Rules array whose declared
// order differs from what WAFv2 echoes back. WAFv2 returns Rules ordered by
// Priority; here we declare them OUT of priority order. If WAFv2 reorders the
// array and `Rules` is not folded as an unordered (identity-keyed) object array,
// a positional diff false-flags `Rules` on a freshly deployed + recorded WebACL.
// A clean record -> check MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2RuleReorder");

const vis = (name: string) => ({
  sampledRequestsEnabled: true,
  cloudWatchMetricsEnabled: true,
  metricName: name,
});

new CfnWebACL(stack, "WebAcl", {
  name: "cdkrd-integ-rule-reorder",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: vis("cdkrdRuleReorder"),
  // Declared OUT of priority order on purpose (3, 1, 2) to expose any
  // WAFv2-side reordering of the top-level Rules array.
  rules: [
    {
      name: "rate-rule",
      priority: 3,
      action: { block: {} },
      visibilityConfig: vis("rateRule"),
      statement: {
        rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
      },
    },
    {
      name: "geo-rule",
      priority: 1,
      action: { block: {} },
      visibilityConfig: vis("geoRule"),
      statement: {
        geoMatchStatement: { countryCodes: ["US", "CA", "GB"] },
      },
    },
    {
      name: "managed-rule",
      priority: 2,
      overrideAction: { none: {} },
      visibilityConfig: vis("managedRule"),
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesCommonRuleSet",
        },
      },
    },
  ],
});

app.synth();

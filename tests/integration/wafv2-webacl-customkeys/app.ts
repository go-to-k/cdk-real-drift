// CDK app for the cdk-real-drift WAFv2 WebACL RateBasedStatement.CustomKeys
// reorder false-positive test (issue #440 follow-up).
//
// The sibling wafv2-ratecustomkeys fixture proved AWS::WAFv2::RuleGroup preserves
// the CustomKeys order; this confirms the SAME rule-out on AWS::WAFv2::WebACL — the
// more common host of a rate-based rule. A rate-based rule's `CustomKeys` is a SET
// of discriminated-union aggregate-key objects ({UriPath:{…}}, {Header:{…}},
// {HTTPMethod:{}}, {Cookie:{…}}, {QueryArgument:{…}}) — a single-discriminator,
// no-IDENTITY_FIELD shape that produced confirmed reorder FPs for WAFv2
// LoggingConfiguration RedactedFields (#433) and Lambda ESM KafkaBootstrapServers
// (#437). If WAF echoed the set sorted (not in template order) and `CustomKeys`
// were not folded as an unordered nested object array, a positional diff would
// false-flag every shifted key as declared drift on a freshly recorded WebACL.
//
// The keys are declared in a deliberately NON-sorted discriminator order
// (UriPath, Header, HTTPMethod, Cookie, QueryArgument) so any WAF-side
// canonicalization shows up. A clean record -> check MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2WebAclCustomKeys");

const noneTransform = [{ priority: 0, type: "NONE" }];

new CfnWebACL(stack, "WebAcl", {
  name: "cdkrd-integ-webacl-customkeys",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdWebAclCustomKeys",
  },
  rules: [
    {
      name: "rate-custom-keys",
      priority: 0,
      action: { block: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "rateCustomKeys",
      },
      statement: {
        rateBasedStatement: {
          limit: 2000,
          aggregateKeyType: "CUSTOM_KEYS",
          // Declared NON-sorted by discriminator key on purpose to expose any
          // WAF-side reordering of the CustomKeys set.
          customKeys: [
            { uriPath: { textTransformations: noneTransform } },
            { header: { name: "x-region", textTransformations: noneTransform } },
            { httpMethod: {} },
            { cookie: { name: "session", textTransformations: noneTransform } },
            { queryArgument: { name: "lang", textTransformations: noneTransform } },
          ],
        },
      },
    },
  ],
});

app.synth();

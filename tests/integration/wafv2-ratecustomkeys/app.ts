// CDK app for the cdk-real-drift WAFv2 RuleGroup RateBasedStatement.CustomKeys
// reorder false-positive test (issue #440).
//
// A rate-based rule's `CustomKeys` is a SET of discriminated-union aggregate-key
// objects ({UriPath:{…}}, {Header:{…}}, {HTTPMethod:{}}, {Cookie:{…}},
// {QueryArgument:{…}}) — the same single-discriminator, no-IDENTITY_FIELD shape
// that produced confirmed reorder FPs for WAFv2 LoggingConfiguration RedactedFields
// (#433) and Lambda ESM KafkaBootstrapServers (#437). If WAF echoes the set sorted
// (by the discriminator key, not in template order) and `CustomKeys` is not folded
// as an unordered nested object array, a positional diff false-flags every shifted
// key as declared drift on a freshly deployed + recorded RuleGroup.
//
// The keys are declared in a deliberately NON-sorted discriminator order
// (UriPath, Header, HTTPMethod, Cookie, QueryArgument) so any WAF-side
// canonicalization shows up. A clean record -> check MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnRuleGroup } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2RateCustomKeys");

const noneTransform = [{ priority: 0, type: "NONE" }];

new CfnRuleGroup(stack, "RuleGroup", {
  name: "cdkrd-integ-rate-customkeys",
  scope: "REGIONAL",
  capacity: 500,
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdRateCustomKeys",
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

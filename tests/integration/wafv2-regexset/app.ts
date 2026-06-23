// CDK app for the cdk-real-drift wafv2-regexset reorder false-positive test.
// WAFv2 RegexPatternSet `RegularExpressionList` is the sibling of WAFv2 IPSet
// `Addresses`, which AWS is proven to echo in its own canonical order (folded as
// UNORDERED_ARRAY_PROPS). The existing RegexPatternSet corpus declared its list
// already in ASCII order, so the reorder is UNTESTED. Declared here in deliberately
// scrambled (non-canonical) order with 3 elements: if AWS returns them sorted, a
// freshly recorded `check` false-flags the reordered-but-identical set as declared
// drift. Cloud Control reads RegularExpressionList back (it is NOT write-only), so the
// reorder, if any, is observable. Serverless, ~30s deploy, no NAT.
import { App, Stack } from "aws-cdk-lib";
import { CfnRegexPatternSet } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2Regexset");

new CfnRegexPatternSet(stack, "RegexSet", {
  name: "cdkrd-regexset",
  scope: "REGIONAL",
  // scrambled: sorted ASCII order would be alpha, mango, zebra.
  regularExpressionList: ["^/zebra/.*$", "^/alpha/.*$", "^/mango/.*$"],
});

app.synth();

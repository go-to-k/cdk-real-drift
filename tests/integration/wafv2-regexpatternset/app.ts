// CDK app for the cdk-real-drift WAFv2 RegexPatternSet false-positive test.
// RegexPatternSet.RegularExpressionList is a SET-like array: WAFv2 stores the
// regex strings as a set and echoes them back in its own (not the declared)
// order — the same set-like reorder class already suppressed for this service's
// sibling IPSet.Addresses (UNORDERED_ARRAY_PROPS, R84). RegularExpressionList is
// NOT yet in that set, so a RegexPatternSet with multiple entries declared in a
// non-sorted order may false-drift positionally. A freshly deployed + recorded
// set with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnRegexPatternSet } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2RegexPatternSet");

// Declare the regexes in a deliberately non-sorted order; WAFv2 returns them in
// its own order, so a positional compare on RegularExpressionList would FP.
new CfnRegexPatternSet(stack, "RegexSet", {
  name: "cdkrd-fp-regexset",
  scope: "REGIONAL",
  regularExpressionList: ["^/zeta", "^/alpha", "^/mike/[0-9]+", "\\.php$"],
});

app.synth();

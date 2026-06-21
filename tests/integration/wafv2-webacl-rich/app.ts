// CDK app for the cdk-real-drift WAFv2 WebACL false-positive test.
// A WAFv2 WebACL is a very commonly deployed protection in front of ALB / API
// Gateway / CloudFront. Its Rules carry deeply NESTED, set-like statement arrays
// (AndStatement.Statements, OrStatement.Statements) whose element order AWS does
// NOT preserve relative to the template — exactly the nested-array-reorder shape
// that produced a false positive on Bedrock Guardrail (#283). A freshly deployed
// + recorded WebACL with NO out-of-band change MUST be CLEAN: any `declared`
// drift on its Rules is a normalization (array-ordering) false positive.
import { App, Stack } from "aws-cdk-lib";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2WebAclRich");

const vis = (name: string) => ({
  sampledRequestsEnabled: true,
  cloudWatchMetricsEnabled: true,
  metricName: name,
});

new CfnWebACL(stack, "WebAcl", {
  name: "cdkrd-integ-webacl",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: vis("cdkrdWebAcl"),
  rules: [
    // Rule with a nested AndStatement holding multiple sub-statements (a set AWS
    // may echo in a different order than declared).
    {
      name: "and-rule",
      priority: 0,
      action: { block: {} },
      visibilityConfig: vis("andRule"),
      statement: {
        andStatement: {
          statements: [
            {
              geoMatchStatement: { countryCodes: ["US", "CA", "GB"] },
            },
            {
              byteMatchStatement: {
                searchString: "bad-bot",
                fieldToMatch: { singleHeader: { Name: "user-agent" } },
                textTransformations: [
                  { priority: 0, type: "LOWERCASE" },
                  { priority: 1, type: "NONE" },
                ],
                positionalConstraint: "CONTAINS",
              },
            },
            {
              sizeConstraintStatement: {
                fieldToMatch: { body: {} },
                comparisonOperator: "GT",
                size: 8192,
                textTransformations: [{ priority: 0, type: "NONE" }],
              },
            },
          ],
        },
      },
    },
    // Rule with a nested OrStatement (another set) and a NotStatement.
    {
      name: "or-not-rule",
      priority: 1,
      action: { count: {} },
      visibilityConfig: vis("orNotRule"),
      statement: {
        orStatement: {
          statements: [
            {
              notStatement: {
                statement: {
                  geoMatchStatement: { countryCodes: ["FR", "DE"] },
                },
              },
            },
            {
              byteMatchStatement: {
                searchString: "/admin",
                fieldToMatch: { uriPath: {} },
                textTransformations: [{ priority: 0, type: "NONE" }],
                positionalConstraint: "STARTS_WITH",
              },
            },
          ],
        },
      },
    },
    // A managed rule group — common, and exercises the override-action set.
    {
      name: "aws-common",
      priority: 2,
      overrideAction: { none: {} },
      visibilityConfig: vis("awsCommon"),
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesCommonRuleSet",
        },
      },
    },
    // Rate-based rule — common DDoS protection.
    {
      name: "rate-rule",
      priority: 3,
      action: { block: {} },
      visibilityConfig: vis("rateRule"),
      statement: {
        rateBasedStatement: {
          limit: 2000,
          aggregateKeyType: "IP",
        },
      },
    },
  ],
});

app.synth();

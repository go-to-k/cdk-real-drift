// CDK app for the cdk-real-drift WAFv2 LoggingConfiguration false-positive test.
// WAF logging (to a CloudWatch `aws-waf-logs-*` group) is a daily compliance setup
// for any WebACL. It packs the FP-prone surfaces: RedactedFields (a set-like array
// of FieldToMatch objects) and LoggingFilter.Filters[].Conditions[] (nested object
// arrays) that AWS may default-fill / re-serialize / reorder server-side. A freshly
// deployed + recorded LoggingConfiguration with NO out-of-band change MUST be CLEAN.
import { App, Aws, Stack } from "aws-cdk-lib";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnLoggingConfiguration, CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2LoggingRich");

const acl = new CfnWebACL(stack, "WebAcl", {
  name: "cdkrd-wafv2-logging",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdLogWebAcl",
  },
  rules: [
    {
      name: "AWSCommon",
      priority: 0,
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

// WAF logging requires the destination CloudWatch log group name to start with
// `aws-waf-logs-`. The LoggingConfiguration destination ARN must NOT carry the
// trailing `:*` that CfnLogGroup.attrArn includes, so build it explicitly.
const logGroup = new CfnLogGroup(stack, "WafLogGroup", {
  logGroupName: "aws-waf-logs-cdkrd-rich",
  retentionInDays: 7,
});
const logGroupArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:aws-waf-logs-cdkrd-rich`;

const logging = new CfnLoggingConfiguration(stack, "WafLogging", {
  resourceArn: acl.attrArn,
  logDestinationConfigs: [logGroupArn],
  // RedactedFields declared NON-sorted and with three distinct shapes — a set-like
  // array AWS may reorder. authorization header, then method, then query string.
  redactedFields: [
    { singleHeader: { Name: "authorization" } },
    { method: {} },
    { queryString: {} },
  ],
  // Nested filter with two conditions in a deliberate order — exercises descent into
  // LoggingFilter.Filters[].Conditions[] (a nested object array).
  loggingFilter: {
    DefaultBehavior: "KEEP",
    Filters: [
      {
        Behavior: "DROP",
        Requirement: "MEETS_ANY",
        Conditions: [
          { ActionCondition: { Action: "COUNT" } },
          { ActionCondition: { Action: "BLOCK" } },
        ],
      },
    ],
  },
});
logging.addDependency(logGroup);

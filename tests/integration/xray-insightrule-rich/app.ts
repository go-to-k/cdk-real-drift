// CDK app for the cdk-real-drift xray-insightrule-rich false-positive integration test.
// Zero-coverage observability types: AWS::XRay::Group (InsightsConfiguration),
// AWS::XRay::SamplingRule (the full nested SamplingRule object with wildcard
// matchers + Attributes map), and AWS::CloudWatch::InsightRule (Contributor
// Insights — RuleBody is a JSON-STRING property, a recurring object<->string
// normalization FP class). A clean `record`->`check` is the FP oracle; the
// SamplingRule FixedRate is the mutable-prop FN probe (verify-detect.sh).
import { App, Stack } from "aws-cdk-lib";
import { CfnInsightRule } from "aws-cdk-lib/aws-cloudwatch";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnGroup, CfnSamplingRule } from "aws-cdk-lib/aws-xray";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegXrayInsightRich");

new CfnGroup(stack, "XrayGroup", {
  groupName: "cdkrd-hunt-xray-group",
  filterExpression: 'service("cdkrd-hunt-svc")',
  insightsConfiguration: {
    insightsEnabled: true,
    notificationsEnabled: false,
  },
});

new CfnSamplingRule(stack, "XraySamplingRule", {
  samplingRule: {
    ruleName: "cdkrd-hunt-sampling",
    priority: 9000,
    fixedRate: 0.05,
    reservoirSize: 1,
    serviceName: "cdkrd-hunt-svc",
    serviceType: "*",
    host: "*",
    httpMethod: "GET",
    urlPath: "/api/*",
    resourceArn: "*",
    version: 1,
    attributes: { env: "hunt" },
  },
});

const logGroup = new LogGroup(stack, "InsightLogs", {
  logGroupName: "/cdkrd/hunt/insightrule",
  retention: RetentionDays.ONE_DAY,
});

new CfnInsightRule(stack, "InsightRule", {
  ruleName: "cdkrd-hunt-insight-rule",
  ruleState: "ENABLED",
  ruleBody: JSON.stringify({
    Schema: { Name: "CloudWatchLogRule", Version: 1 },
    LogGroupNames: [logGroup.logGroupName],
    LogFormat: "JSON",
    Contribution: {
      Keys: ["$.requestId"],
      Filters: [{ Match: "$.status", GreaterThan: 499 }],
    },
    AggregateOn: "Count",
  }),
});

app.synth();

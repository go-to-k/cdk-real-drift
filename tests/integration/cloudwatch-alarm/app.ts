// CDK app for the cdk-real-drift CloudWatch Alarm false-positive integration test
// (R88). Tricky declared property: Dimensions — an unordered array of {Name,Value}
// objects (NOT Key/Id-keyed), which AWS may return reordered. If the identity-keyed
// array canonicalization does not cover Name-keyed arrays, a reorder surfaces as a
// false declared drift — exactly the kind of gap this fixture is here to catch.
import { App, Stack, Tags } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric } from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAlarm");

const metric = new Metric({
  namespace: "AWS/Lambda",
  metricName: "Errors",
  dimensionsMap: { FunctionName: "cdkrd-integ-fn", Resource: "cdkrd-integ-fn:live" },
  statistic: "Sum",
});

const alarm = new Alarm(stack, "Alarm", {
  metric,
  threshold: 5,
  evaluationPeriods: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
});
Tags.of(alarm).add("team", "platform");

app.synth();

// CDK app for the cdk-real-drift CloudWatch metric-math Alarm false-positive integ
// test. UNCOVERED config: a MathExpression alarm synthesizes a `Metrics` array of
// MetricDataQuery objects (two MetricStat entries + one Expression entry), instead of
// the flat top-level MetricName/Namespace/Statistic of a single-metric alarm. AWS
// fills defaults into each element (ReturnData, the MetricStat Period) and may return
// the Id-keyed array reordered — so a positional/default-naive diff false-flags
// declared drift on the error-rate alarm pattern every SRE deploys. This fixture is
// the FP probe for that Metrics-array shape; the existing cloudwatch-alarm fixture
// covers the single-metric (Dimensions) shape.
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMathAlarm");

const errors = new Metric({
  namespace: "AWS/Lambda",
  metricName: "Errors",
  dimensionsMap: { FunctionName: "cdkrd-mathalarm-fn" },
  statistic: "Sum",
  period: Duration.minutes(5),
});
const invocations = new Metric({
  namespace: "AWS/Lambda",
  metricName: "Invocations",
  dimensionsMap: { FunctionName: "cdkrd-mathalarm-fn" },
  statistic: "Sum",
  period: Duration.minutes(5),
});
const errorRate = new MathExpression({
  expression: "(errors / invocations) * 100",
  usingMetrics: { errors, invocations },
  label: "Error Rate (%)",
});

const alarm = new Alarm(stack, "MathAlarm", {
  metric: errorRate,
  threshold: 5,
  evaluationPeriods: 3,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
  alarmDescription: "cdkrd metric-math error-rate alarm",
});
Tags.of(alarm).add("team", "platform");

app.synth();

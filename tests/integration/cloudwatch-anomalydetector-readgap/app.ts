// CDK app for the cdk-real-drift CloudWatch AnomalyDetector read-gap test
// (issue #461). AWS::CloudWatch::AnomalyDetector is NON_PROVISIONABLE in the CFn
// registry (no Cloud Control read handler), so before the SDK_OVERRIDES reader it
// was a silent `skipped` on every stack that uses the standard anomaly-detection
// alarm pattern. The detector targets a metric that needs no backing resource (a
// detector on a not-yet-emitting metric is valid and trains once data arrives), so
// the fixture is self-contained. Configuration is the ONE mutable property — the
// FN half of verify.sh flips MetricTimezone out of band and asserts detect+revert.
import { App, Stack } from "aws-cdk-lib";
import { CfnAnomalyDetector } from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCwAnomaly");

new CfnAnomalyDetector(stack, "Detector", {
  singleMetricAnomalyDetector: {
    namespace: "AWS/Lambda",
    metricName: "Errors",
    stat: "Sum",
    dimensions: [{ name: "FunctionName", value: "cdkrd-integ-anomaly-fn" }],
  },
  configuration: {
    metricTimeZone: "Asia/Tokyo",
    // Declared in the CFn Range pattern (zone-less UTC — the schema REJECTS a
    // trailing Z at deploy). The reader must project the API's Date objects in the
    // SAME pattern or every declared range false-flags on a clean stack.
    excludedTimeRanges: [
      { startTime: "2026-12-24T00:00:00", endTime: "2026-12-26T00:00:00" },
    ],
  },
});

// Metric-math detector with a query Label: DescribeAnomalyDetectors never echoes
// the cosmetic Label back, so without the SDK_READER_GAP_PATHS strip a declared
// label false-flags `desired="send rate" actual=undefined` on a clean stack.
new CfnAnomalyDetector(stack, "MetricMath", {
  metricMathAnomalyDetector: {
    metricDataQueries: [
      {
        id: "m1",
        metricStat: {
          metric: {
            namespace: "AWS/SQS",
            metricName: "NumberOfMessagesSent",
            dimensions: [{ name: "QueueName", value: "cdkrd-integ-anomaly-q" }],
          },
          period: 300,
          stat: "Sum",
        },
        returnData: false,
      },
      { id: "e1", expression: "m1/300", label: "send rate", returnData: true },
    ],
  },
});

app.synth();

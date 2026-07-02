// CDK app for the cdk-real-drift anomalydetector-rich integration test (#461).
// AWS::CloudWatch::AnomalyDetector is NON_PROVISIONABLE in the registry (no Cloud
// Control read handler), so before the SDK_OVERRIDES reader every declared detector
// came back `skipped`. Two detectors exercise both identity shapes the reader
// resolves from the declared model:
//   - single-metric via the SingleMetricAnomalyDetector wrapper, with a rich
//     Configuration (MetricTimeZone + ExcludedTimeRanges — the mutable knobs the
//     detect script flips out of band);
//   - metric-math via MetricMathAnomalyDetector (matched by its MetricDataQueries
//     identity, not by any physical id — the CFn physical id is a guid no API takes).
// Anomaly detectors are free; deploy/delete is instant.
import { App, Stack } from "aws-cdk-lib";
import { CfnAnomalyDetector } from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAnomalyDetector");

new CfnAnomalyDetector(stack, "SingleMetric", {
  singleMetricAnomalyDetector: {
    namespace: "AWS/Lambda",
    metricName: "Errors",
    dimensions: [{ name: "FunctionName", value: "cdkrd-hunt-anomaly-fn" }],
    stat: "Sum",
  },
  configuration: {
    metricTimeZone: "UTC",
    excludedTimeRanges: [
      { startTime: "2026-12-24T00:00:00", endTime: "2026-12-26T00:00:00" },
    ],
  },
});

new CfnAnomalyDetector(stack, "MetricMath", {
  metricMathAnomalyDetector: {
    metricDataQueries: [
      {
        id: "m1",
        metricStat: {
          metric: {
            namespace: "AWS/SQS",
            metricName: "NumberOfMessagesSent",
            dimensions: [{ name: "QueueName", value: "cdkrd-hunt-anomaly-q" }],
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

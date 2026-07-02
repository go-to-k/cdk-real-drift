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
  },
});

app.synth();

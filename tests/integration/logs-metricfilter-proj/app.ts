// CDK app for the AWS::Logs::MetricFilter projection false-negative test. A log group +
// a metric filter that does NOT declare ApplyOnTransformedLogs.
//
// The MetricFilter SDK-override reader projected FilterPattern + MetricTransformations but
// OMITTED ApplyOnTransformedLogs — so an out-of-band toggle (which changes whether the
// filter evaluates transformed vs original log events, i.e. what the metric counts) was
// invisible. verify-metricfilter-proj.sh asserts CLEAN after record (FP guard: a never-set
// filter's ApplyOnTransformedLogs=false folds via isTrivialEmpty), then flips it to true out
// of band and asserts cdkrd DETECTS it.
import { App, Stack } from "aws-cdk-lib";
import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMetricFilter");
const lg = new LogGroup(stack, "Lg");
new MetricFilter(stack, "Mf", {
  logGroup: lg,
  metricNamespace: "CdkrdInteg",
  metricName: "Errors",
  filterPattern: FilterPattern.literal("ERROR"),
});
app.synth();

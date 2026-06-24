// cdk-real-drift Logs MetricFilter detect->revert->clean integration test.
// AWS::Logs::MetricFilter is read via the DescribeMetricFilters SDK override (Cloud
// Control GetResource ValidationExceptions its composite id) and was NOT revertable —
// `revert` said "type not revertable yet" while detection worked, so an out-of-band
// FilterPattern edit was detected but could not be undone. The new writeMetricFilter
// (PutMetricFilter upsert) closes that gap. verify.sh mutates the declared FilterPattern
// out of band, asserts check DETECTS it, reverts, and asserts check is CLEAN + the live
// pattern is restored.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMetricFilterRevert");

const lg = new LogGroup(stack, "Lg", { removalPolicy: RemovalPolicy.DESTROY });

new MetricFilter(stack, "Mf", {
  logGroup: lg,
  filterPattern: FilterPattern.literal('"ERROR"'),
  metricNamespace: "CdkrdRevertTest",
  metricName: "ErrorCount",
  metricValue: "1",
  defaultValue: 0,
});

app.synth();

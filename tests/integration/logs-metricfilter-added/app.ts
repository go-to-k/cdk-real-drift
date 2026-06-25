// Minimal CDK app for the cdk-real-drift `added` integ test on CloudWatch Logs (the
// EIGHTH CHILD_ENUMERATORS member). A LogGroup with ONE declared MetricFilter. verify.sh
// then `put-metric-filter`s additional filters on the SAME log group out of band (via the
// AWS CLI) — whole MetricFilter resources not in the template — and asserts cdkrd reports
// them under [Potential Drift] (PR4: an unrecorded added resource is inventory, not drift),
// records + watches them, and can revert (delete) them.
//
// IMPORTANT: CDK's LogGroup DEFAULTS its removalPolicy to RETAIN — leaving the group (and
// its billing) behind on destroy. We set RemovalPolicy.DESTROY so teardown removes it and
// cascades its metric filters, so there are no stack-external orphans.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegLogsMetricFilterAdded");

const logGroup = new LogGroup(stack, "Lg", {
  removalPolicy: RemovalPolicy.DESTROY,
});

new MetricFilter(stack, "DeclaredMf", {
  logGroup,
  metricNamespace: "cdkrd/integ",
  metricName: "Declared",
  filterPattern: FilterPattern.literal('"declared"'),
}); // declared metric filter — must NOT flag

app.synth();

// CDK app for the cdk-real-drift logs-subscriptionfilter-rich integration test.
// AWS::Logs::SubscriptionFilter is a daily-driver type (log fan-out to Kinesis /
// Lambda / Firehose) with NO golden-corpus coverage yet, and its `FilterPattern` is
// a free-form text expression AWS may echo with normalized whitespace — a
// false-positive candidate. It is also Cloud Control read/update-capable, so it
// doubles as the false-NEGATIVE half: FilterPattern is a declared MUTABLE property a
// console edit can change, and revert can write it back. A LogGroup + a Kinesis
// destination stream is cheap (on-demand stream, no NAT, no stateful provisioning).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import { FilterPattern, LogGroup, SubscriptionFilter } from "aws-cdk-lib/aws-logs";
import { KinesisDestination } from "aws-cdk-lib/aws-logs-destinations";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLogsSubscriptionfilterRich");

const logGroup = new LogGroup(stack, "AppLogs", {
  removalPolicy: RemovalPolicy.DESTROY,
});

const stream = new Stream(stack, "Sink", {
  streamMode: StreamMode.ON_DEMAND,
});

new SubscriptionFilter(stack, "Filter", {
  logGroup,
  destination: new KinesisDestination(stream),
  // A JSON metric-filter expression with internal spacing — the whitespace-coercion
  // probe. AWS may re-emit it with normalized spaces.
  filterPattern: FilterPattern.literal('{ $.level = "ERROR" || $.level = "WARN" }'),
  filterName: "cdkrd-errors",
});

app.synth();

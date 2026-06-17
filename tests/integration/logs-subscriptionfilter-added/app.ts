// CDK app for the cdk-real-drift `added` integ on CloudWatch Logs SUBSCRIPTION filters
// (a second child type of the AWS::Logs::LogGroup parent, alongside metric filters). A
// LogGroup + a trivial Lambda destination + ONE declared SubscriptionFilter. verify.sh then
// `put-subscription-filter`s an UNDECLARED subscription filter on the SAME log group out of
// band (a whole AWS::Logs::SubscriptionFilter resource not in the template — the
// security-relevant case: streaming the log group's events to an out-of-band destination)
// and asserts cdkrd detects it and can revert (delete) it.
//
// IMPORTANT: CDK's LogGroup DEFAULTS removalPolicy to RETAIN — leaving the group (and its
// billing) behind. We set RemovalPolicy.DESTROY so teardown removes it and CASCADES its
// subscription filters, so there are no stack-external orphans. (CloudWatch Logs limits a
// log group to 2 subscription filters, so the integ uses 1 declared + 1 out-of-band.)
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Code, Function as LambdaFn, Runtime } from "aws-cdk-lib/aws-lambda";
import { FilterPattern, LogGroup, SubscriptionFilter } from "aws-cdk-lib/aws-logs";
import { LambdaDestination } from "aws-cdk-lib/aws-logs-destinations";

const app = new App();
const stack = new Stack(app, "CdkrdIntegLogsSubscriptionFilterAdded");

const fn = new LambdaFn(stack, "Dest", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => {};"),
});

const logGroup = new LogGroup(stack, "Lg", {
  removalPolicy: RemovalPolicy.DESTROY,
});

new SubscriptionFilter(stack, "DeclaredSub", {
  logGroup,
  destination: new LambdaDestination(fn),
  filterPattern: FilterPattern.allEvents(),
}); // declared subscription filter — must NOT flag

app.synth();

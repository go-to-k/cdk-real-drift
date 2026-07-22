// Lambda EventSourceMapping probes (real AWS):
// 1. FilterCriteria.Filters is a set of {Pattern} objects with no identity
//    key — no noise.ts allowlist covers it and no corpus case carries
//    FilterCriteria at all, so whether Lambda reorders the set is unprobed.
//    Deploy an SQS ESM with two filters, deliberately unsorted.
// 2. A barest Kinesis ESM leaves ParallelizationFactor / TumblingWindow /
//    Bisect* undeclared (first-run fold probe); verify.sh then mutates
//    ParallelizationFactor out of band and probes detect -> revert -> live
//    convergence (the bare-`remove` no-op class).
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722Esm");

const fnCode = lambda.Code.fromInline(
  "exports.handler = async () => ({ statusCode: 200 });",
);

const queue = new Queue(stack, "HuntQueue", {
  visibilityTimeout: Duration.seconds(120),
});

const sqsFn = new lambda.Function(stack, "HuntSqsFn", {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: fnCode,
});
queue.grantConsumeMessages(sqsFn);

new lambda.CfnEventSourceMapping(stack, "HuntSqsEsm", {
  functionName: sqsFn.functionName,
  eventSourceArn: queue.queueArn,
  batchSize: 10,
  filterCriteria: {
    filters: [
      { pattern: '{"body":{"zz":[{"exists":true}]}}' },
      { pattern: '{"body":{"aa":[{"exists":true}]}}' },
    ],
  },
});

const stream = new Stream(stack, "HuntStream", {
  streamMode: StreamMode.PROVISIONED,
  shardCount: 1,
});

const kinesisFn = new lambda.Function(stack, "HuntKinesisFn", {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: fnCode,
});
stream.grantRead(kinesisFn);

new lambda.CfnEventSourceMapping(stack, "HuntKinesisEsm", {
  functionName: kinesisFn.functionName,
  eventSourceArn: stream.streamArn,
  startingPosition: "LATEST",
});

app.synth();

// cdk-real-drift S3 event-notification false-positive test.
// S3 bucket NotificationConfiguration (Lambda + SQS + SNS targets) is one of the
// most common S3 features yet untested here. AWS generates a notification config
// `Id` per target when none is supplied, may reorder the per-target config arrays,
// and normalizes Filter.Key.FilterRules — all classic FP surfaces. A freshly
// deployed + recorded bucket with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import {
  LambdaDestination,
  SnsDestination,
  SqsDestination,
} from "aws-cdk-lib/aws-s3-notifications";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3NotifRich");

const fn = new LambdaFunction(stack, "Handler", {
  runtime: Runtime.PYTHON_3_12,
  handler: "index.handler",
  code: Code.fromInline("def handler(event, context):\n    return True\n"),
});
const queue = new Queue(stack, "Queue");
const topic = new Topic(stack, "Topic");

const bucket = new Bucket(stack, "Bucket", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

// Three distinct targets, each with a prefix/suffix filter (FilterRules).
bucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(fn), {
  prefix: "uploads/",
  suffix: ".jpg",
});
bucket.addEventNotification(EventType.OBJECT_REMOVED, new SqsDestination(queue), {
  prefix: "archive/",
});
bucket.addEventNotification(EventType.OBJECT_CREATED, new SnsDestination(topic), {
  prefix: "notify/",
  suffix: ".txt",
});

app.synth();

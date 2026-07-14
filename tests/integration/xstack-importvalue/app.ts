// CDK app for the cdk-real-drift CROSS-STACK (Fn::ImportValue) false-positive test.
// No existing fixture is a multi-stack app: every one deploys a single stack, so the
// cross-stack reference path — CDK auto-generating Outputs/Exports on the producer and
// `Fn::ImportValue` in the consumer's DECLARED properties — has never been exercised
// live end-to-end (only unit-tested via the intrinsic resolver's prefetched exports).
// This is one of the most common real-world CDK shapes (any multi-stack app).
//
// The consumer embeds the imported values in several distinct declared positions:
//   - SNS::Subscription.TopicArn        — a bare top-level Fn::ImportValue
//   - SQS::QueuePolicy policy document  — Fn::ImportValue nested inside a policy Condition
//     (created automatically by SqsSubscription for a cross-stack topic)
//   - CloudWatch::Alarm Dimensions[].Value — Fn::ImportValue inside an object array
//   - SSM::Parameter.Value              — a bare string-typed import
// A freshly deployed + recorded app MUST report CLEAN on every stack, and the first
// (pre-record) check must show ZERO [Potential Drift] and ZERO unresolved on these.
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric } from "aws-cdk-lib/aws-cloudwatch";
import { Topic } from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");

const producer = new Stack(app, "CdkrdHuntXstkProd");
const topic = new Topic(producer, "Topic");
const producerQueue = new Queue(producer, "ProdQueue", {
  visibilityTimeout: Duration.seconds(45),
});

const consumer = new Stack(app, "CdkrdHuntXstkCons");
const consumerQueue = new Queue(consumer, "ConsQueue", {
  visibilityTimeout: Duration.seconds(45),
});

// Cross-stack subscription: CDK places the Subscription (and the QueuePolicy granting
// the topic) in the QUEUE's stack, importing the topic ARN from the producer.
topic.addSubscription(new SqsSubscription(consumerQueue));

// The producer queue's NAME crosses stacks into an alarm dimension value.
new Alarm(consumer, "ProdQueueDepthAlarm", {
  metric: new Metric({
    namespace: "AWS/SQS",
    metricName: "ApproximateNumberOfMessagesVisible",
    dimensionsMap: { QueueName: producerQueue.queueName },
    period: Duration.minutes(5),
  }),
  threshold: 100,
  evaluationPeriods: 3,
  comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
});

// The topic ARN crosses stacks into a bare string-typed parameter value.
new StringParameter(consumer, "TopicArnParam", {
  parameterName: "/cdkrd-hunt/xstack/topic-arn",
  stringValue: topic.topicArn,
});

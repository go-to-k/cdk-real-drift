// CDK app for the cdk-real-drift standalone SNS Subscription false-positive test.
// A standalone AWS::SNS::Subscription (topic -> SQS) with a FilterPolicy is one of
// the most common fan-out patterns. It packs the FP-prone surfaces: FilterPolicy
// (declared as a JSON OBJECT, often read back as a JSON-STRING — the object-vs-string
// shape class), RedrivePolicy (a JSON-string with an ARN), RawMessageDelivery (a
// boolean), and FilterPolicyScope (an enum). A freshly deployed + recorded
// Subscription with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTopic, CfnSubscription } from "aws-cdk-lib/aws-sns";
import { CfnQueue, CfnQueuePolicy } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsSubscriptionRich");

const topic = new CfnTopic(stack, "Topic", { topicName: "cdkrd-sub-topic" });
const queue = new CfnQueue(stack, "Queue", { queueName: "cdkrd-sub-queue" });
const dlq = new CfnQueue(stack, "Dlq", { queueName: "cdkrd-sub-dlq" });

new CfnQueuePolicy(stack, "QueuePolicy", {
  queues: [queue.ref],
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: queue.attrArn,
        Condition: { ArnEquals: { "aws:SourceArn": topic.ref } },
      },
    ],
  },
});

new CfnSubscription(stack, "Subscription", {
  topicArn: topic.ref,
  protocol: "sqs",
  endpoint: queue.attrArn,
  rawMessageDelivery: true,
  filterPolicyScope: "MessageAttributes",
  // Declared as a JSON OBJECT — the object-vs-JSON-string shape class.
  filterPolicy: {
    eventType: ["order_placed", "order_cancelled"],
    priority: [{ numeric: [">=", 5] }],
  },
  // RedrivePolicy is a JSON-STRING with a dead-letter ARN.
  redrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.attrArn }),
});

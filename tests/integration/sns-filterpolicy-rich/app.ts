// CDK app for the cdk-real-drift sns-filterpolicy-rich integration test.
// An SNS Subscription FilterPolicy is a JSON document whose attribute values are
// OR-match value-LISTS (a message matches if ANY listed value matches — order is
// meaningless). The value-lists sit under user-chosen attribute keys (not a fixed
// path, not id-shaped), so no existing fold reaches them and the positional deep
// compare would false-flag an AWS re-serialization that reorders them. The single
// existing FilterPolicy corpus case declared its list already-sorted, so a reorder
// was never exercised. We declare the lists NON-sorted to probe whether SNS reorders
// on store; a clean record→check must be CLEAN. An SQS-subscribed topic is fully
// in-account (no external endpoint, no confirmation needed).
import { App, Stack } from "aws-cdk-lib";
import { SubscriptionFilter, Topic } from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsFilterpolicyRich");

const topic = new Topic(stack, "Topic");
const queue = new Queue(stack, "Queue");

topic.addSubscription(
  new SqsSubscription(queue, {
    rawMessageDelivery: true,
    filterPolicy: {
      // OR-set value-lists declared deliberately NON-sorted
      tier: SubscriptionFilter.stringFilter({ allowlist: ["gold", "bronze", "silver"] }),
      region: SubscriptionFilter.stringFilter({
        allowlist: ["us-west-2", "eu-west-1", "ap-south-1"],
      }),
    },
  }),
);

app.synth();

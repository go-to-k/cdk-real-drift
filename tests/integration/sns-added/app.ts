// Minimal CDK app for the cdk-real-drift `added` integ test on SNS (the THIRD
// CHILD_ENUMERATORS member). An SNS Topic with ONE declared subscription (to Queue,
// which auto-confirms). verify.sh subscribes the OTHER two queues to the topic out of
// band (via the AWS CLI) — whole Subscription resources not in the template — and
// asserts cdkrd reports them under [Potential Drift] (PR4: an unrecorded added resource is
// inventory, not drift), records + watches them, and can revert (delete) them.
//
// Two EXTRA queues exist because SNS Subscribe is idempotent per (topic, protocol,
// endpoint): re-subscribing the SAME queue returns the existing arn (no new resource),
// so each out-of-band subscription needs a DISTINCT endpoint. The extra queues are
// stack resources, so delstack tears them down — no stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import { Topic } from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegSnsAdded");

const topic = new Topic(stack, "Topic");
const queue = new Queue(stack, "Queue");
topic.addSubscription(new SqsSubscription(queue)); // declared subscription — must NOT flag
new Queue(stack, "QueueRecord"); // endpoint for the out-of-band record-path subscription
new Queue(stack, "QueueRevert"); // endpoint for the out-of-band revert-path subscription

app.synth();

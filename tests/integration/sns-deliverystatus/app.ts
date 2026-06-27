// CDK app for the cdk-real-drift SNS Topic DeliveryStatusLogging SET FP test. A
// Topic's `DeliveryStatusLogging` is a SET of per-protocol logging configs the CFn
// schema marks insertionOrder:false. Its element key is `Protocol`, which is NOT one
// of cdkrd's IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), so a keyed
// canonicalizer cannot align a reorder. The four protocol entries are declared in
// DELIBERATELY non-sorted order; if SNS echoes the list sorted by Protocol, a
// positional compare false-flags every shifted entry as declared drift on a freshly
// recorded topic. SNS topics + an IAM feedback role are free. A clean record ->
// check MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTopic } from "aws-cdk-lib/aws-sns";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsDeliveryStatus");

const feedbackRole = new Role(stack, "FeedbackRole", {
  assumedBy: new ServicePrincipal("sns.amazonaws.com"),
});
feedbackRole.addToPolicy(
  new PolicyStatement({
    actions: [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:PutMetricFilter",
      "logs:PutRetentionPolicy",
    ],
    resources: ["*"],
  })
);

new CfnTopic(stack, "Topic", {
  topicName: "cdkrd-sns-deliverystatus",
  // Per-protocol delivery-status logging declared NON-sorted by Protocol
  // (sqs before application before lambda before firehose).
  deliveryStatusLogging: [
    {
      protocol: "sqs",
      successFeedbackRoleArn: feedbackRole.roleArn,
      failureFeedbackRoleArn: feedbackRole.roleArn,
      successFeedbackSampleRate: "100",
    },
    {
      protocol: "application",
      successFeedbackRoleArn: feedbackRole.roleArn,
      failureFeedbackRoleArn: feedbackRole.roleArn,
      successFeedbackSampleRate: "100",
    },
    {
      protocol: "lambda",
      successFeedbackRoleArn: feedbackRole.roleArn,
      failureFeedbackRoleArn: feedbackRole.roleArn,
      successFeedbackSampleRate: "100",
    },
    {
      protocol: "firehose",
      successFeedbackRoleArn: feedbackRole.roleArn,
      failureFeedbackRoleArn: feedbackRole.roleArn,
      successFeedbackSampleRate: "100",
    },
  ],
});

app.synth();

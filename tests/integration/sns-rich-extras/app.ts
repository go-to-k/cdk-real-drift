// SNS topic exercising rich config not covered by sns-fifo: a standard topic with an
// explicit signature version, an active tracing config, a display name, and a
// delivery-policy (a JSON document — a shape-coercion FP candidate). SNS is a
// daily-driver type; clean record->check is the FP oracle.
import { App, Stack } from "aws-cdk-lib";
import { CfnTopic, Topic, TracingConfig } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsRichExtras");

const topic = new Topic(stack, "Events", {
  displayName: "cdkrd events topic",
  tracingConfig: TracingConfig.ACTIVE,
  signatureVersion: "2",
});

// DeliveryPolicy is a JSON document AWS may echo as a parsed object or a JSON string —
// a shape-coercion FP candidate. Set on the L1.
const cfn = topic.node.defaultChild as CfnTopic;
cfn.deliveryPolicy = {
  http: {
    defaultHealthyRetryPolicy: {
      numRetries: 3,
      minDelayTarget: 20,
      maxDelayTarget: 20,
      numNoDelayRetries: 0,
      numMinDelayRetries: 0,
      numMaxDelayRetries: 0,
      backoffFunction: "linear",
    },
    disableSubscriptionOverrides: false,
  },
};

app.synth();

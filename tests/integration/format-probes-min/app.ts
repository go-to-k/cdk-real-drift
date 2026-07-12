// CDK app for the cdk-real-drift format-probes-min false-positive integration test.
// Declared-tier normalization probes (allowlist-gap predictions):
// - AWS::SNS::Subscription FilterPolicy: multi-key JSON — does SNS reorder /
//   reformat the echoed policy (object<->JSON-string shape divergence)?
// - AWS::ApplicationAutoScaling::ScalableTarget ScheduledActions.*.Schedule:
//   does the service canonicalize `rate(60 minutes)` (Synthetics does)?
// - A bare SQS queue + PROVISIONED DynamoDB table ride along as the round-3
//   revert-convergence mutation targets (undeclared VisibilityTimeout /
//   DeletionProtectionEnabled).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnScalableTarget } from "aws-cdk-lib/aws-applicationautoscaling";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSubscription, Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713FormatProbes");

// -- SNS multi-key FilterPolicy probe (raw L1 so the declared JSON is exactly ours) --
const topic = new Topic(stack, "HuntTopic");
const subQueue = new Queue(stack, "HuntSubQueue", {
  removalPolicy: RemovalPolicy.DESTROY,
});
new CfnSubscription(stack, "HuntRawSub", {
  topicArn: topic.topicArn,
  protocol: "sqs",
  endpoint: subQueue.queueArn,
  filterPolicy: {
    eventType: ["order_placed", "order_cancelled"],
    priceUsd: [{ numeric: [">=", 100] }],
    store: ["example_corp"],
  },
});

// -- ApplicationAutoScaling ScheduledActions rate() probe --
const table = new Table(stack, "HuntTable", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PROVISIONED,
  removalPolicy: RemovalPolicy.DESTROY,
});

const scalingRole = new Role(stack, "HuntScalingRole", {
  assumedBy: new ServicePrincipal("application-autoscaling.amazonaws.com"),
});

new CfnScalableTarget(stack, "HuntScalableTarget", {
  serviceNamespace: "dynamodb",
  resourceId: `table/${table.tableName}`,
  scalableDimension: "dynamodb:table:ReadCapacityUnits",
  minCapacity: 1,
  maxCapacity: 3,
  roleArn: scalingRole.roleArn,
  scheduledActions: [
    {
      scheduledActionName: "cdkrd-hunt-sched",
      schedule: "rate(60 minutes)",
      scalableTargetAction: { minCapacity: 1, maxCapacity: 3 },
    },
  ],
});

// -- round-3 mutation targets (kept barest) --
new Queue(stack, "HuntBareQueue", {
  queueName: "cdkrd-hunt-bare-queue",
  removalPolicy: RemovalPolicy.DESTROY,
});

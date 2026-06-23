// cdk-real-drift EventBridge Rule Targets per-element default-fill test.
// A Rule's `Targets` is an object array keyed by `Id`; AWS injects per-target server
// defaults (e.g. RetryPolicy / a normalized Arn) the template never declared, which a
// naive whole-array compare false-flags. A freshly deployed + recorded rule with NO
// out-of-band change MUST be CLEAN (the injected sub-fields surface as nested
// undeclared inventory, not declared drift). Two targets (SNS + SQS) expose any
// reorder/inject; both are cheap (no VPC).
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { SnsTopic, SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEventBridgeTargetFill");

const topic = new Topic(stack, "Topic");
const queue = new Queue(stack, "Queue", { removalPolicy: RemovalPolicy.DESTROY });

new Rule(stack, "Rule", {
  schedule: Schedule.rate(Duration.hours(1)),
  targets: [new SnsTopic(topic), new SqsQueue(queue)],
});

app.synth();

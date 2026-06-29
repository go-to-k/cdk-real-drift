// cdk-real-drift — removed-collection REVERT test (issue #421 TASK 2) on an
// EventBridge Rule's `Targets`. Targets are managed by a SEPARATE API (PutTargets /
// RemoveTargets), so this is the most likely common type where a removed collection
// is DETECTED (#416) but the whole-property re-add via Cloud Control UpdateResource is
// the question this fixture answers: deploy a rule with two targets, remove them out of
// band, assert `check` detects the removal, then `revert` re-applies the whole Targets
// collection and a re-check is CLEAN. Both targets are cheap (no VPC).
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { SnsTopic, SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEventsRuleTargetRevert");

const topic = new Topic(stack, "Topic");
const queue = new Queue(stack, "Queue", { removalPolicy: RemovalPolicy.DESTROY });

new Rule(stack, "Rule", {
  schedule: Schedule.rate(Duration.hours(1)),
  targets: [new SnsTopic(topic), new SqsQueue(queue)],
});

app.synth();

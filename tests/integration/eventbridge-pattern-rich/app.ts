// CDK app for the cdk-real-drift eventbridge-pattern-rich integration test.
// AWS::Events::Rule is a daily-driver type, but every existing Events::Rule fixture
// uses ScheduleExpression only — the EventPattern path is untested. Cloud Control
// returns EventPattern as a PARSED OBJECT (confirmed live), and its value-arrays
// (`source`, `detail-type`, `detail.*`) are OR-match SETS (a request matches if ANY
// value matches — order carries no meaning). None of these nested scalar value-lists
// is id/ARN-shaped, so the generic id-array sort skips them, and no per-type fold
// lists Events::Rule — an UNGUARDED set-reorder gap. We declare each array NON-sorted
// to provoke an AWS canonical re-sort; a clean record→check must be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { Rule } from "aws-cdk-lib/aws-events";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEventbridgePatternRich");

new Rule(stack, "MatrixRule", {
  ruleName: "cdkrd-integ-pattern-rule",
  eventPattern: {
    // top-level OR-set value-lists, declared deliberately NON-alphabetical
    source: ["aws.ecs", "aws.ec2", "aws.batch"],
    detailType: ["zeta-event", "alpha-event", "mike-event"],
    // nested-under-object value-list (detail.<key>), also NON-sorted
    detail: {
      state: ["terminated", "running", "pending"],
    },
  },
});

app.synth();

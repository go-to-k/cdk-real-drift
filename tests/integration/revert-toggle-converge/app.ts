// Revert-convergence fixture for the cdk-real-drift bug hunt: two undeclared defaults
// that are folded by KNOWN_DEFAULTS but whose live values are toggled ONLY by a
// DEDICATED provider API (not a settable scalar in the resource update), so a revert that
// merely OMITS the property (a Cloud Control `remove`) is a SILENT NO-OP — Cloud Control
// reports SUCCESS yet the live value persists. This is the #597 / #1541 class.
//
//   1. AWS::Events::Rule State (default ENABLED) — toggled by EnableRule/DisableRule.
//   2. AWS::Kinesis::Stream RetentionPeriodHours (default 24) — changed only by
//      Increase/DecreaseStreamRetentionPeriod.
//
// Both are barest (State / RetentionPeriodHours undeclared), so each folds to atDefault on
// a first check. verify-detect.sh mutates each out of band, asserts detection, then reverts
// and asserts the LIVE value actually returns to the default — the assertion that catches
// the no-op. Without the REVERT_SET_DEFAULT_PATHS fix, revert claims CLEAN but the live
// value stays mutated.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnRule } from "aws-cdk-lib/aws-events";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntRevertToggle0713");

// Barest scheduled rule: only a schedule, no State, no targets.
new CfnRule(stack, "Rule", {
  scheduleExpression: "rate(1 day)",
});

// Barest provisioned stream: only a shard count, no RetentionPeriodHours.
new CfnStream(stack, "Stream", {
  shardCount: 1,
});

app.synth();

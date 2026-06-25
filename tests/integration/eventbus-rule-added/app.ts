// Minimal CDK app for the cdk-real-drift `added` integ test on EventBridge (the FIFTH
// CHILD_ENUMERATORS member). A custom EventBus with ONE declared Rule. verify.sh then
// `put-rule`s additional rules on the SAME bus out of band (via the AWS CLI) — whole
// Rule resources not in the template — and asserts cdkrd reports them under
// [Potential Drift] (PR4: an unrecorded added resource is inventory, not drift), records +
// watches them, and can revert (delete) them.
//
// The declared rule carries an event pattern (a rule on a custom bus needs a pattern,
// not a schedule) and no target — target-less is valid and keeps the fixture minimal;
// the out-of-band rules verify.sh injects are likewise target-less so Cloud Control
// DeleteResource removes them cleanly. The bus is a stack resource, so delstack tears it
// and its rules down — no stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";

const app = new App();
const stack = new Stack(app, "CdkrdIntegEventBusAdded");

const bus = new EventBus(stack, "Bus");

new Rule(stack, "DeclaredRule", {
  eventBus: bus,
  eventPattern: { source: ["cdkrd.integ.declared"] },
}); // declared rule — must NOT flag

app.synth();

// Minimal CDK app for the cdk-real-drift `added` integ test on Lambda (the FOURTH
// CHILD_ENUMERATORS member). A Function with ONE declared event source mapping (an SQS
// queue). verify.sh then `create-event-source-mapping`s the OTHER two queues to the
// function out of band (via the AWS CLI) — whole EventSourceMapping resources not in
// the template — and asserts cdkrd reports them under [Not Recorded] (PR4: an
// unrecorded added resource is inventory, not drift), records + watches them, and can
// revert (delete) them.
//
// Two EXTRA queues exist because Lambda rejects a duplicate mapping for the same
// (function, event source) — each out-of-band mapping needs a DISTINCT source. The
// function's role is granted consume on all three (CreateEventSourceMapping validates
// SQS access), and the queues are stack resources, so delstack tears them down — no
// stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkrdIntegLambdaEsmAdded");

const fn = new LambdaFunction(stack, "Fn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => {};"),
});

const declared = new Queue(stack, "QueueDeclared");
fn.addEventSource(new SqsEventSource(declared)); // declared mapping — must NOT flag

// Endpoints for the out-of-band mappings; grant consume so CreateEventSourceMapping's
// SQS access check passes when verify.sh wires them up.
for (const id of ["QueueRecord", "QueueRevert"]) {
  const q = new Queue(stack, id);
  q.grantConsumeMessages(fn);
}

app.synth();

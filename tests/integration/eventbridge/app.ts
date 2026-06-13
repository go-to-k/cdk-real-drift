// CDK app for the cdk-real-drift EventBridge false-positive integration test (R88).
// Tricky declared properties: EventPattern — declared as an OBJECT, returned by AWS
// as a JSON STRING (R75); and Targets — an array. Adding the SQS target also creates
// a queue policy (policy canonicalization).
import { App, Stack, Tags } from "aws-cdk-lib";
import { Rule } from "aws-cdk-lib/aws-events";
import { SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEvents");

const target = new Queue(stack, "Target");

const rule = new Rule(stack, "Rule", {
  eventPattern: {
    source: ["cdkrd.integ"],
    detailType: ["test-a", "test-b"],
  },
});
rule.addTarget(new SqsQueue(target));
Tags.of(rule).add("team", "platform");

app.synth();

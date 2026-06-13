// CDK app for the cdk-real-drift multi-type MUTATION integration test (R91).
//
// The false-NEGATIVE guard (the opposite of the noise/false-positive fixtures):
// each resource DECLARES a property with a known value; verify.sh changes that
// value out of band and asserts `check` DETECTS it. A normalizer that is too
// aggressive (e.g. collapsing a real change) would make cdkrd miss the drift and
// silently report CLEAN — this catches that. Every mutated property is one cdkrd
// reads back via Cloud Control, so detection is the correct expectation.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMutation");

new Queue(stack, "Queue", { visibilityTimeout: Duration.seconds(30) }); // -> mutate to 60

new Topic(stack, "Topic", { displayName: "original-name" }); // -> mutate DisplayName

new Function(stack, "Fn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  timeout: Duration.seconds(10), // -> mutate to 30
});

new Bucket(stack, "Bucket", { versioned: true, removalPolicy: RemovalPolicy.DESTROY }); // -> suspend

new Repository(stack, "Repo", {
  imageTagMutability: TagMutability.IMMUTABLE, // -> mutate to MUTABLE
  removalPolicy: RemovalPolicy.DESTROY,
  emptyOnDelete: true,
});

app.synth();

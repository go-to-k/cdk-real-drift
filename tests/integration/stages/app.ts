// Minimal CDK app exercising the CDK `Stage` construct (the CDK Pipelines /
// multi-env pattern): one TOP-LEVEL stack and one stack nested inside a Stage.
// verify-stages.sh asserts cdkrd discovers BOTH — the staged stack is invisible
// to `cloudAssembly.stacks` (top-level only) and requires `stacksRecursively`.
import { App, Stack, Stage } from "aws-cdk-lib";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();

const top = new Stack(app, "TopStack");
new Topic(top, "TopTopic");

const stage = new Stage(app, "ProdStage");
const staged = new Stack(stage, "ApiStack");
new Topic(staged, "ApiTopic");

app.synth();

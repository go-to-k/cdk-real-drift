// Minimal CDK app with a `NestedStack`: the parent holds an SNS topic plus a
// NestedStack whose own SNS topic is the CHILD resource. cdkrd checks the parent's
// `AWS::CloudFormation::Stack` resource but does NOT recurse into the child stack, so
// the child topic is unchecked — verify-nested.sh asserts `check` LOUDLY warns about
// that coverage gap (it must never silently read CLEAN over an unchecked child stack).
import { App, Stack, NestedStack } from "aws-cdk-lib";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const parent = new Stack(app, "CdkRealDriftIntegNested");
new Topic(parent, "ParentTopic");
const child = new NestedStack(parent, "ChildNested");
new Topic(child, "ChildTopic");
app.synth();

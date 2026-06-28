// CDK app for the cdk-real-drift map-shaped-Tags revert integration test.
// An AWS::SSM::Parameter has MAP-shaped Tags (key->value object, not a {Key,Value}[] list).
// verify.sh records a clean baseline, adds an out-of-band tag key, then asserts cdkrd
// detects it as a nested `Tags.<key>` undeclared drift and REVERTS it — a single-key
// `remove /Tags/<key>` Cloud Control applies while leaving the aws:* managed tags untouched.
import { App, Stack, Tags } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSsmMapTag");
const p = new StringParameter(stack, "P", { stringValue: "hello" });
Tags.of(p).add("declaredKey", "declaredVal");
app.synth();

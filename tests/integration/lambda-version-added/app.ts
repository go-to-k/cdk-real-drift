// Minimal CDK app for the cdk-real-drift `added` integ test on Lambda versions (the
// Lambda Function enumerator's FOURTH child kind, after event source mappings, function
// URLs, and aliases). A Function with ONE declared published Version (version 1).
// verify.sh then `publish-version`s OTHER versions to the function out of band (via the
// AWS CLI) — whole AWS::Lambda::Version resources not in the template — and asserts cdkrd
// reports them under [Not Recorded] (PR4: an unrecorded added resource is inventory, not
// drift), records + watches them, and can revert (delete) them.
//
// `fn.currentVersion` publishes version 1 = the declared version (its physical id, the Ref,
// IS the versioned FunctionArn `arn:...:function:Fn:1`). The `$LATEST` pseudo-version is
// NOT a real AWS::Lambda::Version resource and the enumerator skips it. The version is part
// of the function / stack, so delstack tears it down — no stack-external orphans.
import { App, CfnOutput, Stack } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkrdIntegLambdaVersionAdded");

const fn = new LambdaFunction(stack, "Fn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => {};"),
});

// Declared version — must NOT flag. `fn.currentVersion` publishes version 1 as an
// AWS::Lambda::Version resource (its Ref is the versioned FunctionArn). Force a CfnOutput
// so the version is realized as a stack resource (and the reference is not tree-shaken).
new CfnOutput(stack, "DeclaredVersionArn", { value: fn.currentVersion.functionArn });

app.synth();

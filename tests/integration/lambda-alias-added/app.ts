// Minimal CDK app for the cdk-real-drift `added` integ test on Lambda aliases (the
// Lambda Function enumerator's THIRD child kind, after event source mappings and
// function URLs). A Function with a published version and ONE declared alias (`live`).
// verify.sh then `create-alias`es OTHER aliases to the function out of band (via the
// AWS CLI) — whole AWS::Lambda::Alias resources not in the template — and asserts cdkrd
// reports them under [Not Recorded] (PR4: an unrecorded added resource is inventory, not
// drift), records + watches them, and can revert (delete) them.
//
// `fn.currentVersion` publishes version 1, which the declared alias points at and which
// verify.sh's out-of-band aliases also point at (so create-alias succeeds). The version
// and aliases are part of the function / stack, so delstack tears them down — no
// stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import { Alias, Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkrdIntegLambdaAliasAdded");

const fn = new LambdaFunction(stack, "Fn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => {};"),
});

// Declared alias — must NOT flag. `fn.currentVersion` publishes version 1.
new Alias(stack, "DeclaredAlias", { aliasName: "live", version: fn.currentVersion });

app.synth();

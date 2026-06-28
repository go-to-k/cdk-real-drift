// CDK app for the cdk-real-drift Lambda free-form-map + Alias-revert integration test.
// One Lambda with a DECLARED env var (a free-form Environment.Variables map), plus an
// Alias on its current version with NO declared Description. verify.sh injects an
// out-of-band UNDECLARED env var and an out-of-band Alias Description, then asserts:
//   - the undeclared env var is SURFACED (a free-form map key, not folded into the
//     undeclared-subkey count);
//   - reverting the undeclared env var REMOVES it (a pure-dotted nested path is
//     revertable via Cloud Control);
//   - reverting the undeclared Alias Description CLEARS it (UpdateAlias ignores an
//     omitted description, so revert must write the empty-string default, not `remove`).
import { App, Stack } from "aws-cdk-lib";
import { Alias, Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaFreeform");
const fn = new Function(stack, "Fn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  environment: { USER_POOL_ID_PARAMETER_STORE_NAME: "/auth/goto/user-pool-id" },
});
new Alias(stack, "Alias", { aliasName: "live", version: fn.currentVersion });
app.synth();

// Minimal CDK app for the cdk-real-drift `added` integ test on Lambda function URLs
// (extending the FOURTH CHILD_ENUMERATORS member, AWS::Lambda::Function). TWO functions:
//   - FnDeclared WITH a declared function URL (AuthType NONE) — cdkrd must NOT flag it.
//   - FnTarget with NO declared URL — verify.sh then `create-function-url-config`s a
//     public URL on it out of band (via the AWS CLI), a whole AWS::Lambda::Url resource
//     not in the template (security-relevant: an out-of-band public HTTPS endpoint), and
//     asserts cdkrd reports it under [Potential Drift] (PR4: an unrecorded added resource is
//     inventory, not drift), records + watches it, and can revert (delete) it.
//
// A function has at most one URL per qualifier, so the revert path reuses FnTarget by
// delete+reinjecting its single URL (it cannot host a second). Both functions are stack
// resources and deleting a function removes its URL, so delstack tears everything down —
// no stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import {
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkrdIntegLambdaUrlAdded");

const mk = (id: string) =>
  new LambdaFunction(stack, id, {
    runtime: Runtime.NODEJS_20_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => {};"),
  });

const declared = mk("FnDeclared");
declared.addFunctionUrl({ authType: FunctionUrlAuthType.NONE }); // declared — must NOT flag

mk("FnTarget"); // no declared URL — the out-of-band URL is created on this one

app.synth();

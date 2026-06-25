// Minimal CDK app for the cdk-real-drift `added` integ test on AppSync FUNCTIONS
// (extending the AppSync CHILD_ENUMERATORS member to AWS::AppSync::FunctionConfiguration).
// A GraphQL API with ONE NONE data source and ONE DECLARED pipeline function on it.
// verify.sh then `create-function`s additional functions on the SAME api out of band
// (via the AWS CLI) — whole FunctionConfiguration resources not in the template — and
// asserts cdkrd reports them under [Potential Drift] (PR4: an unrecorded added resource is
// inventory, not drift), records + watches them, and can revert (delete) them.
//
// The declared function uses a NONE data source (no backing service needed), keeping the
// fixture minimal; the out-of-band functions verify.sh injects are likewise NONE so
// Cloud Control DeleteResource removes them cleanly. The api is a stack resource, and
// deleting a GraphQLApi CASCADES its functions — no stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import {
  AppsyncFunction,
  Code,
  Definition,
  FunctionRuntime,
  GraphqlApi,
} from "aws-cdk-lib/aws-appsync";

const app = new App();
const stack = new Stack(app, "CdkrdIntegAppSyncFunctionAdded");

const api = new GraphqlApi(stack, "Api", {
  name: "cdkrd-integ-appsync-fn",
  definition: Definition.fromFile("schema.graphql"),
});

const ds = api.addNoneDataSource("Ds");

new AppsyncFunction(stack, "DeclaredFn", {
  api,
  dataSource: ds,
  name: "declaredFn",
  runtime: FunctionRuntime.JS_1_0_0,
  code: Code.fromInline(
    "export function request(){return {};} export function response(ctx){return ctx.result;}"
  ),
}); // declared function — must NOT flag

app.synth();

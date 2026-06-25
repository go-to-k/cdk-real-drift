// Minimal CDK app for the cdk-real-drift `added` integ test on AppSync (the SIXTH
// CHILD_ENUMERATORS member). A GraphQL API with ONE declared NONE data source.
// verify.sh then `create-data-source`s additional data sources on the SAME api out of
// band (via the AWS CLI) — whole DataSource resources not in the template — and asserts
// cdkrd reports them under [Potential Drift] (PR4: an unrecorded added resource is
// inventory, not drift), records + watches them, and can revert (delete) them.
//
// The declared data source is a NONE source (no backing service needed), keeping the
// fixture minimal; the out-of-band data sources verify.sh injects are likewise NONE so
// Cloud Control DeleteResource removes them cleanly. The api is a stack resource, and
// deleting a GraphQLApi CASCADES its data sources — no stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import { Definition, GraphqlApi } from "aws-cdk-lib/aws-appsync";

const app = new App();
const stack = new Stack(app, "CdkrdIntegAppSyncDataSourceAdded");

const api = new GraphqlApi(stack, "Api", {
  name: "cdkrd-integ-appsync",
  definition: Definition.fromFile("schema.graphql"),
});

api.addNoneDataSource("DeclaredDs", { name: "DeclaredDs" }); // declared data source — must NOT flag

app.synth();

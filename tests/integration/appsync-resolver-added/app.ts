// Minimal CDK app for the cdk-real-drift `added` integ test on AppSync RESOLVERS (the
// AppSync CHILD_ENUMERATORS member, extended from data sources to also enumerate
// resolvers). A GraphQL API with ONE declared NONE data source and ONE declared
// resolver on Query.ping. verify.sh then `create-resolver`s additional resolvers on
// OTHER fields (Query.pong, Query.pung) of the SAME api out of band (via the AWS CLI) —
// whole Resolver resources not in the template — and asserts cdkrd reports them under
// [Potential Drift] (PR4: an unrecorded added resource is inventory, not drift), records +
// watches them, and can revert (delete) them.
//
// The declared resolver targets Query.ping, so the declared resolver must NOT be flagged.
// The schema has three fields (ping declared, pong + pung undeclared) so verify.sh can
// attach out-of-band resolvers to the undeclared fields. The api is a stack resource,
// and deleting a GraphQLApi CASCADES its resolvers — no stack-external orphans.
import { App, Stack } from "aws-cdk-lib";
import { Definition, GraphqlApi, MappingTemplate } from "aws-cdk-lib/aws-appsync";

const app = new App();
const stack = new Stack(app, "CdkrdIntegAppSyncResolverAdded");

const api = new GraphqlApi(stack, "Api", {
  name: "cdkrd-integ-appsync-resolver",
  definition: Definition.fromFile("schema.graphql"),
});

const ds = api.addNoneDataSource("DeclaredDs", { name: "DeclaredDs" });

// Declared resolver on Query.ping — must NOT be flagged as added.
ds.createResolver("PingResolver", {
  typeName: "Query",
  fieldName: "ping",
  requestMappingTemplate: MappingTemplate.fromString(
    '{"version":"2018-05-29","payload":{}}',
  ),
  responseMappingTemplate: MappingTemplate.fromString("$util.toJson($ctx.result)"),
});

app.synth();

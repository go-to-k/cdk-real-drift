// cdk-real-drift AppSync GraphQLApi AdditionalAuthenticationProviders reorder test.
// `AdditionalAuthenticationProviders` is an object array keyed by AuthenticationType
// (NOT one of cdkrd's IDENTITY_FIELDS), so a positional compare false-flags every
// shifted provider if AppSync returns them in a different order than declared. The
// existing appsync-graphqlapi-rich corpus declares only ONE additional provider, so a
// reorder is never exercised — this declares TWO in NON-alphabetical order
// (OPENID_CONNECT before AWS_IAM) to reveal any sort-on-read. A freshly deployed +
// recorded API with NO out-of-band change MUST be CLEAN. Uses L1 (no schema needed for
// the API resource to exist) — the cheapest way to control provider order.
import { App, Stack } from "aws-cdk-lib";
import { CfnGraphQLApi } from "aws-cdk-lib/aws-appsync";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAppsyncAddAuthReorder");

new CfnGraphQLApi(stack, "Api", {
  name: "cdkrd-addauth-reorder",
  authenticationType: "API_KEY",
  // Declared NON-alphabetical (OPENID_CONNECT, then AWS_IAM) so a sort-on-read is revealed.
  additionalAuthenticationProviders: [
    {
      authenticationType: "OPENID_CONNECT",
      openIdConnectConfig: { issuer: "https://accounts.google.com" },
    },
    { authenticationType: "AWS_IAM" },
  ],
});

app.synth();

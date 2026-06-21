// CDK app for the cdk-real-drift appsync-graphqlapi-rich false-positive integration
// test. The existing appsync-* fixtures only exercise the `added` tier (out-of-band
// DataSources / Resolvers / Functions). This one stresses the property-RICH
// GraphqlApi body a large fraction of CDK users deploy: X-Ray tracing, a default
// API_KEY authorization with an auto-created key, and an additional IAM auth mode.
// AWS folds the auth config into AdditionalAuthenticationProviders + its own defaults
// — a clean `record`->`check` is a strong false-positive oracle. Field logging is
// deliberately NOT enabled: AppSync would create a /aws/appsync/apis/<id> log group
// outside the stack (an orphan the cdkrd-token sweep cannot reach).
import { fileURLToPath } from "node:url";
import { App, Duration, Expiration, Stack } from "aws-cdk-lib";
import {
  AuthorizationType,
  Definition,
  GraphqlApi,
} from "aws-cdk-lib/aws-appsync";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAppsyncGraphqlapiRich");

const schemaPath = fileURLToPath(new URL("./schema.graphql", import.meta.url));

new GraphqlApi(stack, "Api", {
  name: "cdkrd-appsync-rich",
  definition: Definition.fromFile(schemaPath),
  xrayEnabled: true,
  authorizationConfig: {
    defaultAuthorization: {
      authorizationType: AuthorizationType.API_KEY,
      apiKeyConfig: {
        name: "cdkrd-default-key",
        expires: Expiration.after(Duration.days(30)),
      },
    },
    additionalAuthorizationModes: [
      { authorizationType: AuthorizationType.IAM },
    ],
  },
});

app.synth();

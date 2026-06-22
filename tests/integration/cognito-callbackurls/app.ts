// CDK app for the cdk-real-drift Cognito UserPoolClient CallbackURLs false-positive
// test. CallbackURLs / LogoutURLs are a daily-deployed OAuth surface. Cognito stores
// these URL lists as a SET and echoes them in its own (not the declared) order — the
// same set-like reorder class already suppressed for this type's AllowedOAuthFlows /
// AllowedOAuthScopes (UNORDERED_ARRAY_PROPS, R74). CallbackURLs/LogoutURLs are NOT yet
// in that set, so a multi-URL client may false-drift positionally. A freshly deployed +
// recorded client with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoCallbackUrls");

const pool = new CfnUserPool(stack, "Pool", {
  userPoolName: "cdkrd-fp-callbackurls",
});

// Declare the URLs in a deliberate order; Cognito returns them in its own canonical
// order, so a positional compare on the declared CallbackURLs/LogoutURLs sets would FP.
new CfnUserPoolClient(stack, "Client", {
  userPoolId: pool.ref,
  clientName: "cdkrd-fp-callbackurls-client",
  allowedOAuthFlowsUserPoolClient: true,
  allowedOAuthFlows: ["code", "implicit"],
  allowedOAuthScopes: ["openid", "email", "profile"],
  supportedIdentityProviders: ["COGNITO"],
  callbackUrLs: [
    "https://zeta.example.com/callback",
    "https://alpha.example.com/callback",
    "https://mike.example.com/callback",
  ],
  logoutUrLs: [
    "https://zeta.example.com/logout",
    "https://alpha.example.com/logout",
    "https://mike.example.com/logout",
  ],
});

app.synth();

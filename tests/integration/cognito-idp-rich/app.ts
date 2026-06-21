// CDK app for the cdk-real-drift Cognito identity-provider false-positive test.
// Federating a user pool to an external IdP is a common auth pattern, and
// AWS::Cognito::UserPoolIdentityProvider has not been exercised. Its interesting
// surface is two free-form Map<String,String> properties — ProviderDetails and
// AttributeMapping — which exercise cdkrd's free-form-map handling (the live read
// can reorder keys or echo service-added entries). A social (Google) provider takes
// dummy client credentials that Cognito accepts at create time without validation.
// A freshly deployed + recorded provider with NO out-of-band change MUST report
// CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnUserPool, CfnUserPoolIdentityProvider } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoIdpRich");

const pool = new CfnUserPool(stack, "Pool", {
  userPoolName: "cdkrd-idp-pool",
});

new CfnUserPoolIdentityProvider(stack, "Idp", {
  userPoolId: pool.ref,
  providerName: "Google",
  providerType: "Google",
  providerDetails: {
    client_id: "dummy-client-id.apps.googleusercontent.com",
    client_secret: "dummy-client-secret",
    authorize_scopes: "openid email profile",
  },
  attributeMapping: {
    email: "email",
    username: "sub",
  },
});

app.synth();

// CDK app for the cdk-real-drift Cognito false-positive integration test (R88).
// Tricky declared properties: a UserPoolClient's ExplicitAuthFlows,
// AllowedOAuthFlows / AllowedOAuthScopes and CallbackURLs are UNORDERED enum/string
// arrays AWS may return reordered (R74 unordered-set handling); a UserPoolGroup uses
// a COMPOSITE Cloud Control identifier (UserPoolId|GroupName, R84).
//
// The Pool also declares standardAttributes + customAttributes (WAVE23): CDK emits a
// `Schema` array, but AWS always returns the FULL ~21-attribute set. The declared subset
// must compare element-wise (no whole-array false drift) — `check` (no baseline) must
// find ZERO declared drift, the standard attrs surfacing as foldable undeclared inventory.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CfnUserPoolGroup,
  OAuthScope,
  StringAttribute,
  UserPool,
  UserPoolClient,
} from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognito");

const pool = new UserPool(stack, "Pool", {
  selfSignUpEnabled: true,
  removalPolicy: RemovalPolicy.DESTROY,
  standardAttributes: { email: { required: true, mutable: true } },
  customAttributes: { tier: new StringAttribute({ mutable: true }) },
});

new UserPoolClient(stack, "Client", {
  userPool: pool,
  generateSecret: false,
  authFlows: { userSrp: true, userPassword: true },
  oAuth: {
    flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
    scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
    callbackUrls: ["https://a.example/cb", "https://b.example/cb"],
  },
});

new CfnUserPoolGroup(stack, "Group", {
  userPoolId: pool.userPoolId,
  groupName: "cdkrd-integ-group",
  description: "cdk-real-drift integ group",
});

app.synth();

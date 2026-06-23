// CDK app for the cdk-real-drift cognito-userpool-sets reorder false-positive test.
// Two set-like arrays declared in deliberately NON-canonical (scrambled) order:
//   1. UserPool `AliasAttributes` — a set of sign-in aliases; Cognito is the service
//      whose UserPoolClient OAuth/URL sets were proven to reorder (folded as
//      UNORDERED_ARRAY_PROPS), so its sibling pool-level sets are prime suspects.
//   2. UserPoolResourceServer `Scopes` — an OBJECT array keyed by ScopeName, which is
//      NOT one of cdkrd's IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), so if
//      Cognito reorders it the canonicalizer cannot align it (the EC2
//      BlockDeviceMappings DeviceName / Cognito Schema class).
// If AWS echoes either set in its own canonical order, a freshly recorded `check`
// false-flags the reordered-but-identical set as declared drift. UserPoolResourceServer
// is also a brand-new corpus type (only `added`-tier child coverage existed before).
// Declared with L1 constructs so the array element ORDER is controlled exactly.
import { App, Stack } from "aws-cdk-lib";
import { CfnUserPool, CfnUserPoolResourceServer } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoUserPoolSets");

const pool = new CfnUserPool(stack, "Pool", {
  userPoolName: "cdkrd-userpool-sets",
  // scrambled (non-alphabetical) 3-element sign-in alias set.
  aliasAttributes: ["preferred_username", "phone_number", "email"],
  adminCreateUserConfig: { allowAdminCreateUserOnly: true },
});

new CfnUserPoolResourceServer(stack, "ResourceServer", {
  userPoolId: pool.ref,
  identifier: "cdkrd-api",
  name: "cdkrd-resource-server",
  // scrambled (non-alphabetical) object-array set, keyed by ScopeName.
  scopes: [
    { scopeName: "zeta.write", scopeDescription: "zeta scope" },
    { scopeName: "alpha.read", scopeDescription: "alpha scope" },
    { scopeName: "mike.admin", scopeDescription: "mike scope" },
  ],
});

app.synth();

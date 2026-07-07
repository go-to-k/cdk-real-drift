// Minimal CDK app for the cdk-real-drift Cognito Identity Pool integration test.
//
// Stack CdkRealDriftIntegCognitoIdPoolRich exercises AWS::Cognito::IdentityPool +
// AWS::Cognito::IdentityPoolRoleAttachment — the federated-identity pattern web/mobile
// apps deploy alongside a User Pool. Uses the L1 Cfn* constructs so the native CFn
// types are exercised.
//
// A freshly deployed, un-mutated stack must produce ZERO [Potential Drift] on a first
// `check`. Every value AWS assigns undeclared (e.g. an AllowClassicFlow default) must
// fold to atDefault.
import { App, Stack } from "aws-cdk-lib";
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment } from "aws-cdk-lib/aws-cognito";
import { FederatedPrincipal, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoIdPoolRich");

const pool = new CfnIdentityPool(stack, "IdPool", {
  allowUnauthenticatedIdentities: true,
});

// Unauthenticated role assumable by the identity pool (the classic guest-access role).
const unauthRole = new Role(stack, "UnauthRole", {
  assumedBy: new FederatedPrincipal(
    "cognito-identity.amazonaws.com",
    {
      StringEquals: { "cognito-identity.amazonaws.com:aud": pool.ref },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "unauthenticated" },
    },
    "sts:AssumeRoleWithWebIdentity",
  ),
});
unauthRole.addToPolicy(
  new PolicyStatement({
    actions: ["mobileanalytics:PutEvents", "cognito-sync:*"],
    resources: ["*"],
  }),
);

new CfnIdentityPoolRoleAttachment(stack, "RoleAttachment", {
  identityPoolId: pool.ref,
  roles: { unauthenticated: unauthRole.roleArn },
});

app.synth();

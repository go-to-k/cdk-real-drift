// cdk-real-drift Cognito UserPoolUser read-gap test.
// AWS::Cognito::UserPoolUser primaryIdentifier is the COMPOSITE [UserPoolId,
// Username], but the CFn physical id (Ref) is only the bare Username — so Cloud
// Control GetResource rejects the bare id with a ValidationException and the user is
// silently `skipped` (a read-gap: undeclared drift on it is invisible). This is the
// same parent-first UserPoolId|<child> shape as the already-adapted UserPoolClient /
// UserPoolGroup / UserPoolDomain siblings. After the CC_IDENTIFIER_ADAPTERS fix the
// user reads, so a fresh deploy + record + check is CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnUserPoolUser, UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoUserPoolUserRich");

const pool = new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
  selfSignUpEnabled: false,
});

// Admin-created user; SUPPRESS the welcome message so no email/SMS is sent.
new CfnUserPoolUser(stack, "User", {
  userPoolId: pool.userPoolId,
  username: "cdkrd-readgap-user",
  messageAction: "SUPPRESS",
  userAttributes: [{ name: "email", value: "cdkrd@example.com" }],
});

app.synth();

// CDK app for the cdk-real-drift cognito-userpool-rich false-positive integration
// test. The existing `cognito` fixture covers a thin pool + client + group; this one
// stresses the property-RICH UserPool surface a large fraction of CDK users deploy:
// MFA config, a full password policy, account recovery, multiple sign-in aliases,
// standard attributes, user verification, and device tracking. Each of these folds
// into AWS's flat UserPool model with its own defaults — so a clean `record`->`check`
// is a strong false-positive oracle for the Cognito normalization / default-folding
// path.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AccountRecovery,
  Mfa,
  UserPool,
  VerificationEmailStyle,
} from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoUserPoolRich");

new UserPool(stack, "Pool", {
  userPoolName: "cdkrd-userpool-rich",
  removalPolicy: RemovalPolicy.DESTROY,
  deletionProtection: false,
  selfSignUpEnabled: true,
  signInAliases: { email: true, username: true },
  signInCaseSensitive: false,
  mfa: Mfa.OPTIONAL,
  mfaSecondFactor: { sms: false, otp: true },
  passwordPolicy: {
    minLength: 12,
    requireLowercase: true,
    requireUppercase: true,
    requireDigits: true,
    requireSymbols: true,
    tempPasswordValidity: Duration.days(3),
  },
  accountRecovery: AccountRecovery.EMAIL_ONLY,
  standardAttributes: {
    email: { required: true, mutable: true },
    fullname: { required: false, mutable: true },
  },
  userVerification: {
    emailStyle: VerificationEmailStyle.CODE,
  },
  deviceTracking: {
    challengeRequiredOnNewDevice: true,
    deviceOnlyRememberedOnUserPrompt: true,
  },
});

app.synth();

// cdk-real-drift Cognito UserPool AccountRecoverySetting.RecoveryMechanisms test.
// RecoveryMechanisms is an object array ({Name, Priority}) nested under
// AccountRecoverySetting. AWS may sort it by Priority and/or inject a default
// mechanism the template never declared — either a reorder or a subset/default-fill
// FP on a freshly recorded pool. A freshly deployed + recorded pool with NO out-of-band
// change MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AccountRecovery, UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoRecoverySubset");

new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
  selfSignUpEnabled: false,
  // EMAIL_AND_PHONE_WITHOUT_MFA declares verified_email (priority 1) +
  // verified_phone_number (priority 2) — two mechanisms to expose any reorder/inject.
  accountRecovery: AccountRecovery.EMAIL_AND_PHONE_WITHOUT_MFA,
});

app.synth();

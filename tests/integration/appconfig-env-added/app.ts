// Minimal CDK app for the cdk-real-drift `added` integ test on AppConfig (the FOURTEENTH
// CHILD_ENUMERATORS member). An AppConfig Application with ONE declared Environment.
// verify.sh then `create-environment`s additional environments on the SAME application
// out of band (via the AWS CLI) — whole Environment resources not in the template — and
// asserts cdkrd reports them under [Not Recorded] (PR4: an unrecorded added resource is
// inventory, not drift), records + watches them, and can revert (delete) them.
//
// The out-of-band environments verify.sh injects are removed by the cleanup trap BEFORE
// delstack: AppConfig refuses to delete an application that still has environments, so a
// recorded-but-not-reverted environment would block the application's deletion (the stack
// goes DELETE_FAILED) — and delstack only sees STACK members, not a stack-external
// environment sitting on a member application.
import { App, Stack } from "aws-cdk-lib";
import { CfnApplication, CfnEnvironment } from "aws-cdk-lib/aws-appconfig";

const app = new App();
const stack = new Stack(app, "CdkrdIntegAppConfigEnvAdded");

const appc = new CfnApplication(stack, "App", { name: "cdkrd-integ-appconfig" });

new CfnEnvironment(stack, "DeclaredEnv", {
  applicationId: appc.ref,
  name: "declared",
}); // declared environment — must NOT flag

app.synth();

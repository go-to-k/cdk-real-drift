// Minimal CDK app for the cdk-real-drift `added` integ test on AppConfig configuration
// profiles (a SECOND child of the FOURTEENTH CHILD_ENUMERATORS member, alongside
// environments). An AppConfig Application with ONE declared ConfigurationProfile.
// verify.sh then `create-configuration-profile`s additional profiles on the SAME
// application out of band (via the AWS CLI) — whole ConfigurationProfile resources not in
// the template — and asserts cdkrd reports them under [Not Recorded] (PR4: an unrecorded
// added resource is inventory, not drift), records + watches them, and can revert (delete)
// them.
//
// The out-of-band profiles verify.sh injects are removed by the cleanup trap BEFORE
// delstack: AppConfig refuses to delete an application that still has configuration
// profiles, so a recorded-but-not-reverted profile would block the application's deletion
// (the stack goes DELETE_FAILED) — and delstack only sees STACK members, not a
// stack-external profile sitting on a member application.
import { App, Stack } from "aws-cdk-lib";
import { CfnApplication, CfnConfigurationProfile } from "aws-cdk-lib/aws-appconfig";

const app = new App();
const stack = new Stack(app, "CdkrdIntegAppConfigProfileAdded");

const appc = new CfnApplication(stack, "App", { name: "cdkrd-integ-appconfig-prof" });

new CfnConfigurationProfile(stack, "DeclaredProfile", {
  applicationId: appc.ref,
  name: "declared",
  locationUri: "hosted",
}); // declared configuration profile — must NOT flag

app.synth();

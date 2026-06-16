// Minimal CDK app for the cdk-real-drift `added` integ test on KMS (the TWELFTH
// CHILD_ENUMERATORS member). A KMS Key with ONE declared Alias. verify.sh then
// `create-alias`es additional aliases pointing at the SAME key out of band (via the AWS
// CLI) — whole Alias resources not in the template — and asserts cdkrd reports them
// under [Not Recorded] (PR4: an unrecorded added resource is inventory, not drift),
// records + watches them, and can revert (delete) them.
//
// The key uses RemovalPolicy.DESTROY with the minimum 7-day pendingWindow so teardown
// schedules it for deletion; KMS keys cannot be hard-deleted, so the key sits in
// PendingDeletion after teardown — that is EXPECTED and unavoidable for KMS, not an
// orphan. The declared alias is removed with the stack; verify.sh's cleanup trap removes
// any out-of-band aliases (account-global per region) before delstack.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";

const app = new App();
const stack = new Stack(app, "CdkrdIntegKmsAliasAdded");

const key = new Key(stack, "Key", {
  removalPolicy: RemovalPolicy.DESTROY,
  pendingWindow: Duration.days(7), // 7 = the KMS minimum pending-deletion window
});
key.addAlias("alias/cdkrd-integ-declared"); // declared alias — must NOT flag

app.synth();

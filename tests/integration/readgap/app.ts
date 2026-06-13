// CDK app for the cdk-real-drift "honest gap" integration test (R87).
//
// Some declared properties genuinely CANNOT be read back from AWS — a write-only
// value (a secret, a password) is the canonical case. A change to such a value out
// of band IS real drift, but cdkrd cannot verify it. The design promise is to say
// so HONESTLY (report it in the informational `readGap` tier) rather than silently
// pass it as CLEAN — silently dropping it would make the user blind to a class of
// drift they think is covered.
//
// This fixture declares a SecretsManager secret with a literal `SecretString`
// (write-only). The test asserts that property surfaces as a `readGap` (note:
// write-only) — never silently absent. An explicit secret name lets the cleanup
// trap force-delete it (no 30-day recovery-window residue).
import { App, RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegReadGap");

new Secret(stack, "GapSecret", {
  secretName: "cdkrd-integ-readgap",
  // a literal write-only SecretString in the template — cdkrd declares it but
  // cannot read it back, so it must be reported as a readGap, not silently CLEAN.
  secretStringValue: SecretValue.unsafePlainText("integ-write-only-value"),
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

// CDK app for the cdk-real-drift KMS key-rotation revert-gap test.
//
// AWS::KMS::Key.EnableKeyRotation is a very common, mutable property (a console
// toggle / `disable-key-rotation` call is a classic out-of-band change). It is
// CC-readable, so a change is DETECTED — but KMS rotation is toggled through the
// dedicated EnableKeyRotation/DisableKeyRotation APIs, so a Cloud Control
// UpdateResource patch may silently no-op (the same class as Logs BearerToken /
// IAM Role MaxSessionDuration that needed an SDK writer). This fixture verifies
// detect -> revert -> CLEAN -> live value actually restored.
import { App, Stack } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegKmsRotationRevert");

new Key(stack, "Key", {
  description: "cdkrd kms rotation revert probe",
  enableKeyRotation: true,
});

app.synth();

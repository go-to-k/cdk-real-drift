// CDK app for the cdk-real-drift Lambda CodeSigningConfig false-positive test.
// AWS::Lambda::CodeSigningConfig is the common way to enforce signed Lambda code.
// It carries an AllowedPublishers.SigningProfileVersionArns array plus a
// CodeSigningPolicies block whose UntrustedArtifactOnDeployment defaults to "Warn"
// when omitted — exactly the kind of service default cdkrd must fold without a
// false positive. A freshly deployed + recorded config with NO out-of-band change
// MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnSigningProfile } from "aws-cdk-lib/aws-signer";
import { CfnCodeSigningConfig } from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodeSigningRich");

const profile = new CfnSigningProfile(stack, "Profile", {
  platformId: "AWSLambda-SHA384-ECDSA",
});

new CfnCodeSigningConfig(stack, "Csc", {
  description: "cdkrd code signing probe",
  allowedPublishers: {
    signingProfileVersionArns: [profile.attrProfileVersionArn],
  },
  // CodeSigningPolicies omitted on purpose so AWS fills the "Warn" default.
});

app.synth();

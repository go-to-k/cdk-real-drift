// CDK app for the cdk-real-drift AWS Config ConfigRule governance test. A ConfigRule
// is a governance control — an out-of-band weakening (a looser rotation age) is
// exactly the drift cdkrd should catch. AWS rejects any ConfigRule unless a
// ConfigurationRecorder is active, and the CFn-native recorder hits a well-known
// create-stabilization deadlock (it waits to be "recording", which needs a delivery
// channel ordered after it). So verify.sh provisions the recorder + delivery channel
// via the SDK (no deadlock) and this stack carries ONLY the rule, giving cdkrd a
// declared side to compare. A freshly deployed + recorded rule MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  ManagedRule,
  ManagedRuleIdentifiers,
  MaximumExecutionFrequency,
} from "aws-cdk-lib/aws-config";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegConfigRule");

new ManagedRule(stack, "Rule", {
  configRuleName: "cdkrd-access-keys-rotated",
  identifier: ManagedRuleIdentifiers.ACCESS_KEYS_ROTATED,
  inputParameters: { maxAccessKeyAge: 90 },
  maximumExecutionFrequency: MaximumExecutionFrequency.TWENTY_FOUR_HOURS,
});

app.synth();

// CDK app for the cdk-real-drift ivs-channel-rich false-positive integration test.
// AWS::IVS::Channel (Interactive Video Service) is an uncovered, self-contained,
// instant/cheap type. Most of its defaults ARE schema-annotated (Type=STANDARD,
// LatencyMode=LOW, Authorized=false, ...) and fold via schema.defaults; the FP surface
// is the NON-annotated props AWS may echo undeclared (Preset, MultitrackInputConfiguration).
// Only Name is declared, so a `check` BEFORE record is a false-positive oracle for
// whatever AWS materializes on the rest.
import { App, Stack } from "aws-cdk-lib";
import { CfnChannel } from "aws-cdk-lib/aws-ivs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIvsChannelRich");

new CfnChannel(stack, "Channel", {
  name: "cdkrd-ivs-channel-rich",
});

app.synth();

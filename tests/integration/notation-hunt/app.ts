// Discovery shim for the raw-CFn notation fixture: the REAL template (template.yaml, with
// short-form intrinsics) is deployed via `aws cloudformation deploy` — cdkrd reads the
// DEPLOYED template from CloudFormation for declared intent, so this app exists only to
// let cdkrd resolve the stack by name (stack discovery needs a CDK app).
import { App, Stack, Tags } from "aws-cdk-lib";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
new Stack(app, "CdkrdHuntNotation0712c");
app.synth();

// CDK app for the cdk-real-drift guardduty-securityhub-min false-positive
// integration test. BAREST-possible configs of two zero-coverage,
// account-singleton security staples (deploy only in an account where neither
// service is enabled — the fixture creates and deletes the singleton):
// - AWS::GuardDuty::Detector: only `Enable` declared — Features / DataSources /
//   FindingPublishingFrequency are all AWS-assigned defaults (rich live model).
// - AWS::SecurityHub::Hub: nothing declared — AutoEnableControls /
//   ControlFindingGenerator / EnableDefaultStandards defaults.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDetector } from "aws-cdk-lib/aws-guardduty";
import { CfnHub } from "aws-cdk-lib/aws-securityhub";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegGdSecHubMin");

new CfnDetector(stack, "HuntDetector", { enable: true });

new CfnHub(stack, "HuntHub");

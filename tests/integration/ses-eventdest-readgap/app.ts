// cdk-real-drift SES ConfigurationSetEventDestination read test.
// AWS::SES::ConfigurationSetEventDestination is NOT readable via Cloud Control
// (GetResource throws HandlerInternalFailureException — the read handler is broken
// upstream), so cdkrd reads it via an SDK_OVERRIDES reader (SESv2
// GetConfigurationSetEventDestinations, #1643) instead of surfacing `skipped=1`. The
// reader translates the SESv2 UPPERCASE_SNAKE enums back to the CFn-canonical spelling
// and folds MatchingEventTypes case-insensitively (this fixture declares them UPPERCASE),
// so a freshly deployed + recorded stack MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnConfigurationSet,
  CfnConfigurationSetEventDestination,
} from "aws-cdk-lib/aws-ses";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSesEventDestReadGap");

const cs = new CfnConfigurationSet(stack, "ConfigSet", { name: "cdkrd-ses-reorder" });

new CfnConfigurationSetEventDestination(stack, "Dest", {
  configurationSetName: cs.ref,
  eventDestination: {
    name: "cdkrd-dest",
    enabled: true,
    // Deliberately NON-alphabetical so a sort-on-read is revealed.
    matchingEventTypes: ["DELIVERY", "BOUNCE", "SEND", "COMPLAINT"],
    cloudWatchDestination: {
      dimensionConfigurations: [
        {
          dimensionName: "ses-source",
          dimensionValueSource: "messageTag",
          defaultDimensionValue: "none",
        },
      ],
    },
  },
});

app.synth();

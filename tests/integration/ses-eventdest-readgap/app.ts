// cdk-real-drift SES ConfigurationSetEventDestination read-gap test.
// AWS::SES::ConfigurationSetEventDestination is NOT readable via Cloud Control
// (GetResource throws HandlerInternalFailureException), so cdkrd surfaces it as
// `skipped=1` in the info footer — honestly, NOT as a silent false negative. The
// parent ConfigurationSet reads clean. (It is an SDK_OVERRIDES candidate; the
// MatchingEventTypes enum-set reorder cannot be probed until the EventDestination is
// readable.) A freshly deployed + recorded stack MUST be CLEAN with the skip surfaced.
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

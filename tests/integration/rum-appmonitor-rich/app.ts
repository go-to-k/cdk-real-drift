// CDK app for the cdk-real-drift CloudWatch RUM AppMonitor false-positive test.
// RUM (real-user monitoring for web apps) is a common front-end observability
// resource, and its AppMonitorConfiguration carries several SET-like lists that
// AWS may echo in its own canonical order (Telemetries, ExcludedPages,
// IncludedPages, FavoritePages). Those are declared deliberately NON-sorted so a
// positional compare would false-drift them if RUM reorders. A freshly deployed +
// recorded monitor with NO out-of-band change MUST report CLEAN.
//
// No IdentityPoolId / GuestRoleArn is set (data ingestion is not exercised), so no
// Cognito identity pool is created — nothing to orphan. CwLogEnabled is left false
// so RUM does not create a vended CloudWatch log group.
import { App, Stack } from "aws-cdk-lib";
import { CfnAppMonitor } from "aws-cdk-lib/aws-rum";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRumRich");

new CfnAppMonitor(stack, "Monitor", {
  name: "cdkrd-rum-rich",
  domain: "example.com",
  cwLogEnabled: false,
  customEvents: { status: "ENABLED" },
  appMonitorConfiguration: {
    allowCookies: true,
    enableXRay: false,
    sessionSampleRate: 1,
    // Declared deliberately out of sorted order to expose a set-reorder FP.
    telemetries: ["performance", "errors", "http"],
    excludedPages: [
      "https://example.com/zeta",
      "https://example.com/alpha",
      "https://example.com/mike",
    ],
    includedPages: [
      "https://example.com/include-b",
      "https://example.com/include-a",
    ],
    favoritePages: ["/zeta", "/alpha", "/mike"],
    metricDestinations: [{ destination: "CloudWatch" }],
  },
});

app.synth();

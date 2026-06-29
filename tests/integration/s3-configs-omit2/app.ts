// Probe: which additional S3 sub-configs does Cloud Control OMIT when removed
// (→ same OMITTED_WHEN_EMPTY false-negative as Cors/Lifecycle)? Self-contained
// configs only (no extra resources): Website, OwnershipControls, Metrics,
// IntelligentTiering, Analytics, InventoryConfigurations (skipped — needs dest).
import { App, Stack } from "aws-cdk-lib";
import { CfnBucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3ConfigsOmit2");

new CfnBucket(stack, "Bucket", {
  websiteConfiguration: { indexDocument: "index.html", errorDocument: "error.html" },
  ownershipControls: { rules: [{ objectOwnership: "ObjectWriter" }] },
  metricsConfigurations: [{ id: "EntireBucket" }],
  intelligentTieringConfigurations: [
    { id: "archive", status: "Enabled", tierings: [{ accessTier: "ARCHIVE_ACCESS", days: 90 }] },
  ],
  analyticsConfigurations: [{ id: "a1", storageClassAnalysis: {} }],
});

app.synth();

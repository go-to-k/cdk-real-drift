// S3 Storage Lens configuration (AWS::S3::StorageLens) — a common, FREE (default
// metrics) org/account-level analytics config that no fixture exercises yet. It has a
// deep nested StorageLensConfiguration object with many boolean metric toggles AWS
// materializes at creation (ActivityMetrics/DetailedStatusCodesMetrics/... IsEnabled),
// exactly the first-run undeclared-default noise this hunt targets. Clean record->check
// is the FP oracle; StorageLens is CC-readable and FULLY_MUTABLE.
import { App, Stack } from "aws-cdk-lib";
import { CfnStorageLens } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3StorageLensRich");

new CfnStorageLens(stack, "Lens", {
  storageLensConfiguration: {
    id: "cdkrd-storagelens-rich",
    isEnabled: true,
    accountLevel: {
      bucketLevel: {
        activityMetrics: { isEnabled: true },
      },
      activityMetrics: { isEnabled: true },
    },
  },
});

app.synth();

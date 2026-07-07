// CDK app for the cdk-real-drift location-placeindex-revert integration test.
// A PlaceIndex with no DataSourceConfiguration reads back {IntendedUse:"SingleUse"},
// folded to atDefault by #609. DataSourceConfiguration is a MUTABLE property
// (createOnly is only DataSource/IndexName), so this fixture live-tests the REVERT of
// an out-of-band IntendedUse change back to the default — verifying the fold's
// equality-gate detection AND that revert actually converges (not a silent no-op).
import { App, Stack } from "aws-cdk-lib";
import { CfnPlaceIndex } from "aws-cdk-lib/aws-location";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLocationPlaceIndexRevert");

new CfnPlaceIndex(stack, "PlaceIndex", {
  dataSource: "Esri",
  indexName: "cdkrd-placeindex-revert",
  description: "cdkrd location place index revert test",
});

app.synth();

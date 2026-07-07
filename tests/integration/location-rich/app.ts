// CDK app for the cdk-real-drift location-rich false-positive integration test.
// Amazon Location Service (AWS::Location::*) is an entirely uncovered service in the
// corpus. Its resources fold AWS-assigned first-run values the template never
// declares — ARNs, CreateTime/UpdateTime, and echoed service defaults such as a
// Tracker's PositionFiltering (TimeBased) or a PlaceIndex's
// DataSourceConfiguration.IntendedUse (SingleUse). Several default-prone props are
// deliberately left UNDECLARED here so a `check` BEFORE record is a clean
// false-positive oracle for those undeclared first-run defaults.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnGeofenceCollection,
  CfnMap,
  CfnPlaceIndex,
  CfnRouteCalculator,
  CfnTracker,
} from "aws-cdk-lib/aws-location";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLocationRich");

// PlaceIndex: declare DataSource + name + description; leave DataSourceConfiguration
// (AWS fills IntendedUse=SingleUse) and PricingPlan UNDECLARED.
new CfnPlaceIndex(stack, "PlaceIndex", {
  dataSource: "Esri",
  indexName: "cdkrd-place-index-rich",
  description: "cdkrd location place index rich",
});

// Map: Configuration.Style is required; leave nothing else declared.
new CfnMap(stack, "Map", {
  configuration: { style: "VectorEsriNavigation" },
  mapName: "cdkrd-map-rich",
  description: "cdkrd location map rich",
});

// GeofenceCollection: minimal; PricingPlan/PricingPlanDataSource are deprecated and
// left undeclared.
new CfnGeofenceCollection(stack, "GeofenceCollection", {
  collectionName: "cdkrd-geofence-rich",
  description: "cdkrd location geofence collection rich",
});

// Tracker: leave PositionFiltering (AWS fills TimeBased), EventBridgeEnabled and
// KmsKeyEnableGeospatialQueries UNDECLARED to surface default-fill.
new CfnTracker(stack, "Tracker", {
  trackerName: "cdkrd-tracker-rich",
  description: "cdkrd location tracker rich",
});

// RouteCalculator: declare DataSource + name + description.
new CfnRouteCalculator(stack, "RouteCalculator", {
  dataSource: "Esri",
  calculatorName: "cdkrd-route-calculator-rich",
  description: "cdkrd location route calculator rich",
});

app.synth();

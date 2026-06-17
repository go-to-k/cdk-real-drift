// CDK app for the AWS::Route53::RecordSet GeoProximityLocation projection FN test. A
// hosted zone + a geoproximity A record that declares ONLY AWSRegion (no Bias), so AWS
// sets Bias=0. The reader projected the other routing fields but OMITTED GeoProximityLocation
// — so an out-of-band change to the geoproximity region/bias was invisible.
//
// verify-route53-geoproximity.sh asserts CLEAN after record (FP guard: the live Bias=0 folds
// via KNOWN_DEFAULT_PATHS), then adds a Bias out of band and asserts cdkrd DETECTS it.
import { App, Stack } from "aws-cdk-lib";
import { CfnHostedZone, CfnRecordSet } from "aws-cdk-lib/aws-route53";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRoute53Geo");
const zone = new CfnHostedZone(stack, "Zone", {
  name: "geoproximity.cdkrd-integ-test.com",
});
new CfnRecordSet(stack, "GeoRec", {
  hostedZoneId: zone.attrId,
  name: "geo.geoproximity.cdkrd-integ-test.com.",
  type: "A",
  setIdentifier: "g1",
  ttl: "60",
  resourceRecords: ["1.2.3.4"],
  geoProximityLocation: { awsRegion: "us-east-1" },
});
app.synth();

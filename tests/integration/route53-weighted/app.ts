// Minimal CDK app for the Route53 weighted-record WRONG-MATCH false-positive test.
// A public hosted zone with TWO weighted A records that share Name+Type and differ
// ONLY by SetIdentifier (blue weight 10, green weight 90). The SDK-override reader
// used to fetch MaxItems:1 and match on Type+Name alone, so it read whichever record
// came first (blue) for BOTH declared records — reporting false drift on green
// (declared weight 90 vs blue's live weight 10). The fix lists all variants and
// disambiguates by SetIdentifier. verify-route53-weighted.sh asserts a clean record
// (no wrong-record FP) and that an out-of-band change to the GREEN weight is detected
// on green specifically.
import { App, Stack } from "aws-cdk-lib";
import { CfnHostedZone, CfnRecordSet } from "aws-cdk-lib/aws-route53";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegR53");

const zoneName = "cdkrd-r53-integ.internal.";
const zone = new CfnHostedZone(stack, "Zone", { name: zoneName });

const common = {
  hostedZoneId: zone.ref,
  name: `app.${zoneName}`,
  type: "A",
  ttl: "60",
};
new CfnRecordSet(stack, "Blue", {
  ...common,
  setIdentifier: "blue",
  weight: 10,
  resourceRecords: ["1.1.1.1"],
});
new CfnRecordSet(stack, "Green", {
  ...common,
  setIdentifier: "green",
  weight: 90,
  resourceRecords: ["2.2.2.2"],
});

app.synth();

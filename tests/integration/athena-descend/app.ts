// Integration fixture for #565: descend a FULLY-undeclared Athena WorkGroupConfiguration
// leaf-by-leaf. The workgroup declares NO WorkGroupConfiguration, so a clean deploy reads back
// AWS's whole default config and folds it WHOLE (atDefault). The verify script then sets ONE
// non-default sub-key out of band; the whole-object fold now misses, and cdkrd DESCENDS so only
// that sub-key surfaces (WorkGroupConfiguration.BytesScannedCutoffPerQuery) while the constant
// defaults still fold — instead of surfacing the whole object. Also the corpus-harvest source
// for the descend case (AWS__Athena__WorkGroup.WgDescend.json).
import { App, Stack } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAthenaDescend");

new CfnWorkGroup(stack, "WgDescend", {
  name: "cdkrd-integ-athena-descend",
  description: "cdkrd athena-descend fixture",
  recursiveDeleteOption: true,
  state: "ENABLED",
  // deliberately NO workGroupConfiguration — it reads back AWS's whole default.
});

app.synth();

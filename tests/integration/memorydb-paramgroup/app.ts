import { App, Stack } from "aws-cdk-lib";
import { CfnParameterGroup } from "aws-cdk-lib/aws-memorydb";
const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMemoryDbParamGroup");
new CfnParameterGroup(stack, "Pg", {
  family: "memorydb_redis7",
  parameterGroupName: "cdkrd-integ-memorydb-pg",
  description: "cdkrd integ memorydb redis7 parameter group",
  parameters: { "maxmemory-policy": "allkeys-lru", timeout: "300" },
});
app.synth();

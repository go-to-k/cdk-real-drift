// CDK app for the cdk-real-drift DynamoDB GSI projection nested-set FP test. A
// GlobalSecondaryIndex with ProjectionType INCLUDE carries NonKeyAttributes — a
// SET of plain attribute names nested INSIDE the GlobalSecondaryIndexes array.
// The names are not id/ARN-shaped, so canonicalizeIdArraysDeep does not sort
// them, and UNORDERED_ARRAY_PROPS only reaches TOP-LEVEL arrays — so a nested
// NonKeyAttributes set has no fold. If DynamoDB echoes it reordered, a positional
// compare false-flags declared drift on a freshly deployed + recorded table.
// Declared in DELIBERATELY non-sorted order. DynamoDB is ubiquitous and a
// PAY_PER_REQUEST table deploys in seconds. A clean recorded table MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDdbGsiProjection");

new CfnTable(stack, "Table", {
  tableName: "cdkrd-integ-ddb-gsi-projection",
  billingMode: "PAY_PER_REQUEST",
  attributeDefinitions: [
    { attributeName: "pk", attributeType: "S" },
    { attributeName: "sk", attributeType: "S" },
    { attributeName: "gsipk", attributeType: "S" },
  ],
  keySchema: [
    { attributeName: "pk", keyType: "HASH" },
    { attributeName: "sk", keyType: "RANGE" },
  ],
  globalSecondaryIndexes: [
    {
      indexName: "gsi1",
      keySchema: [{ attributeName: "gsipk", keyType: "HASH" }],
      projection: {
        projectionType: "INCLUDE",
        // A set of non-key attribute names, declared NON-alphabetically.
        nonKeyAttributes: ["zeta", "alpha", "mike", "bravo"],
      },
    },
  ],
});

app.synth();

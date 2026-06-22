// CDK app for the cdk-real-drift DynamoDB nested-set FP test — the SIBLINGS of the
// already-guarded `AWS::DynamoDB::Table` GSI `NonKeyAttributes` reorder (R-class
// UNORDERED_NESTED_OBJECT_ARRAY_PATHS). An INCLUDE projection carries
// `NonKeyAttributes` — a SET of plain attribute names nested INSIDE the
// (Global|Local)SecondaryIndexes array — that DynamoDB echoes ALPHABETICALLY
// sorted, regardless of declaration order. The existing allowlist only covers
// `AWS::DynamoDB::Table` `GlobalSecondaryIndexes.Projection.NonKeyAttributes`; the
// identical shape on a Table's LSI, and on `AWS::DynamoDB::GlobalTable` (TableV2)
// GSI *and* LSI, were unguarded. This fixture declares each in DELIBERATELY
// non-alphabetical order so a positional compare false-flags declared drift on a
// freshly deployed + recorded table unless the fold reaches every path. DynamoDB
// is ubiquitous and PAY_PER_REQUEST tables deploy in seconds. A clean recorded
// stack MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  BillingMode,
  ProjectionType,
  Table,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDdbNestedSets");

// Classic AWS::DynamoDB::Table — exercises the Table LSI gap (and re-covers the
// already-guarded GSI path as a regression). The L2 `Table` takes indexes via
// add*SecondaryIndex methods, NOT constructor props.
const classic = new Table(stack, "Classic", {
  tableName: "cdkrd-integ-ddb-nested-sets-classic",
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY,
});
classic.addLocalSecondaryIndex({
  indexName: "lsi1",
  sortKey: { name: "lsi1sk", type: AttributeType.NUMBER },
  projectionType: ProjectionType.INCLUDE,
  // A set of non-key attribute names, declared NON-alphabetically.
  nonKeyAttributes: ["yankee", "bravo", "oscar", "delta"],
});
classic.addGlobalSecondaryIndex({
  indexName: "gsi1",
  partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
  projectionType: ProjectionType.INCLUDE,
  nonKeyAttributes: ["zeta", "alpha", "mike", "bravo"],
});

// Modern AWS::DynamoDB::GlobalTable (TableV2), single region — exercises the
// GlobalTable GSI *and* LSI gaps.
new TableV2(stack, "Global", {
  tableName: "cdkrd-integ-ddb-nested-sets-global",
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.STRING },
  billing: Billing.onDemand(),
  removalPolicy: RemovalPolicy.DESTROY,
  localSecondaryIndexes: [
    {
      indexName: "lsi1",
      sortKey: { name: "lsi1sk", type: AttributeType.NUMBER },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["sierra", "echo", "november", "alpha"],
    },
  ],
  globalSecondaryIndexes: [
    {
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["quebec", "foxtrot", "tango", "golf"],
    },
  ],
});

app.synth();

// CDK app for the cdk-real-drift DynamoDB false-positive integration test (R88).
// Tricky declared properties: KeySchema / AttributeDefinitions (ordered arrays AWS
// may return in a different order), a GlobalSecondaryIndexes array, and tags.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDynamoDB");

const table = new Table(stack, "Data", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.DESTROY,
});
table.addGlobalSecondaryIndex({
  indexName: "gsi1",
  partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
  sortKey: { name: "gsi1sk", type: AttributeType.NUMBER },
});
Tags.of(table).add("team", "platform");
Tags.of(table).add("cost-center", "1234");

app.synth();

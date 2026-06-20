// CDK app for the cdk-real-drift richly-configured DynamoDB false-positive test.
// DynamoDB is among the most commonly deployed CDK resources. The existing
// `dynamodb` fixture covers the basic table (KeySchema / one GSI / tags); this one
// piles on the "production" knobs that each add their own normalization edge:
// a TTL spec, a DynamoDB Stream, a STANDARD_INFREQUENT_ACCESS table class,
// contributor insights, point-in-time recovery, a local secondary index, and a
// second GSI with a KEYS_ONLY projection. A freshly deployed + recorded table with
// NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  Table,
  TableClass,
} from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDdbRich");

const table = new Table(stack, "Data", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  tableClass: TableClass.STANDARD_INFREQUENT_ACCESS,
  pointInTimeRecovery: true,
  contributorInsightsEnabled: true,
  stream: StreamViewType.NEW_AND_OLD_IMAGES,
  timeToLiveAttribute: "ttl",
  removalPolicy: RemovalPolicy.DESTROY,
});

table.addLocalSecondaryIndex({
  indexName: "lsi1",
  sortKey: { name: "lsi1sk", type: AttributeType.NUMBER },
  projectionType: ProjectionType.ALL,
});

table.addGlobalSecondaryIndex({
  indexName: "gsi1",
  partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
  sortKey: { name: "gsi1sk", type: AttributeType.NUMBER },
});

table.addGlobalSecondaryIndex({
  indexName: "gsi2",
  partitionKey: { name: "gsi2pk", type: AttributeType.STRING },
  projectionType: ProjectionType.KEYS_ONLY,
});

Tags.of(table).add("team", "platform");
Tags.of(table).add("cost-center", "1234");

app.synth();

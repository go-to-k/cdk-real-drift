// CDK app for the cdk-real-drift richly-configured DynamoDB *TableV2* (GlobalTable)
// false-positive test. The existing `dynamodb` and `ddb-rich` fixtures cover the
// classic `AWS::DynamoDB::Table`; this one exercises the modern, increasingly-
// recommended `TableV2` construct, which synthesizes to a *different* resource type
// (`AWS::DynamoDB::GlobalTable`) with a different live shape — a top-level
// `Replicas[]` array where the table class, contributor insights, PITR, and tags
// all live per-replica rather than on the table root. A single-region TableV2 (no
// extra replicas) is the common case and still emits the GlobalTable type. It piles
// on the production knobs that each add their own normalization edge: on-demand
// billing, a DynamoDB Stream, STANDARD_INFREQUENT_ACCESS class, contributor
// insights, point-in-time recovery, AWS-managed encryption, a TTL spec, a local
// secondary index, and two GSIs (one KEYS_ONLY). A freshly deployed + recorded
// table with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  ProjectionType,
  StreamViewType,
  TableClass,
  TableEncryptionV2,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDdbGlobalTableRich");

const table = new TableV2(stack, "Data", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.STRING },
  billing: Billing.onDemand(),
  tableClass: TableClass.STANDARD_INFREQUENT_ACCESS,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  contributorInsightsSpecification: { enabled: true },
  dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
  timeToLiveAttribute: "ttl",
  deletionProtection: false,
  encryption: TableEncryptionV2.dynamoOwnedKey(),
  removalPolicy: RemovalPolicy.DESTROY,
  localSecondaryIndexes: [
    {
      indexName: "lsi1",
      sortKey: { name: "lsi1sk", type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    },
  ],
  globalSecondaryIndexes: [
    {
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: AttributeType.NUMBER },
    },
    {
      indexName: "gsi2",
      partitionKey: { name: "gsi2pk", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    },
  ],
});

Tags.of(table).add("team", "platform");
Tags.of(table).add("cost-center", "1234");

app.synth();

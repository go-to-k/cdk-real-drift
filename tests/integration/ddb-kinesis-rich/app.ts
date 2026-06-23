// cdk-real-drift DynamoDB Kinesis-stream-spec false-positive test.
// A DynamoDB table with a Kinesis data stream (KinesisStreamSpecification) is a
// common CDC pattern not yet exercised. AWS injects a default
// `ApproximateCreationDateTimePrecision` (MICROSECOND) into the spec — a default-
// fill / undeclared surface. Also exercises PITR. A freshly deployed + recorded
// table with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDdbKinesisRich");

const kstream = new Stream(stack, "KStream", {
  streamMode: StreamMode.ON_DEMAND,
});

new Table(stack, "Table", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  sortKey: { name: "sk", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  kinesisStream: kstream,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

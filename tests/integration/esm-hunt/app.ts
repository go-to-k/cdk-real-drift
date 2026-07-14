// False-positive probe (real AWS): Lambda EventSourceMapping with the two
// STREAM sources that have zero fixture coverage — every existing ESM fixture
// is SQS or self-managed Kafka:
// - DynamoDB Streams source (barest: FunctionName + EventSourceArn +
//   StartingPosition) — surfaces the stream-source default family
//   (BatchSize=100, MaximumBatchingWindowInSeconds, BisectBatchOnFunctionError,
//   ParallelizationFactor, MaximumRecordAgeInSeconds, MaximumRetryAttempts,
//   TumblingWindowInSeconds, DestinationConfig, FilterCriteria).
// - Kinesis source (same barest required set, its own default surface).
// Nothing bills while idle beyond one provisioned Kinesis shard (~$0.015/h);
// the streams have no producers so the function never invokes.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { AttributeType, CfnTable, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnEventSourceMapping, CfnFunction } from "aws-cdk-lib/aws-lambda";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Esm");

// --- stream sources, barest ---
const table = new CfnTable(stack, "HuntEsmTable", {
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  attributeDefinitions: [{ attributeName: "pk", attributeType: AttributeType.STRING }],
  billingMode: "PAY_PER_REQUEST",
  streamSpecification: { streamViewType: StreamViewType.NEW_IMAGE },
});
const kstream = new CfnStream(stack, "HuntEsmStream", {
  shardCount: 1,
});

// --- consumer function (barest zip) ---
const role = new Role(stack, "HuntEsmRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
});
// ESM creation validates the role can read the source stream.
role.addToPolicy(
  new PolicyStatement({
    actions: [
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:DescribeStream",
      "dynamodb:ListStreams",
      "kinesis:GetRecords",
      "kinesis:GetShardIterator",
      "kinesis:DescribeStream",
      "kinesis:DescribeStreamSummary",
      "kinesis:ListShards",
      "kinesis:ListStreams",
      "kinesis:SubscribeToShard",
    ],
    resources: ["*"],
  }),
);
const fn = new CfnFunction(stack, "HuntEsmFn", {
  code: { zipFile: "exports.handler = async () => {};" },
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: role.roleArn,
});
fn.node.addDependency(role.node.defaultChild!);

// --- the two uncovered ESM variants, barest ---
const ddbEsm = new CfnEventSourceMapping(stack, "HuntDdbEsm", {
  functionName: fn.ref,
  eventSourceArn: table.attrStreamArn,
  startingPosition: "LATEST",
});
ddbEsm.node.addDependency(role);
const kinesisEsm = new CfnEventSourceMapping(stack, "HuntKinesisEsm", {
  functionName: fn.ref,
  eventSourceArn: kstream.attrArn,
  startingPosition: "LATEST",
});
kinesisEsm.node.addDependency(role);

app.synth();

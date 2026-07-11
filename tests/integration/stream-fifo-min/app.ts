// CDK app for the cdk-real-drift stream-fifo-min false-positive integration
// test. BAREST-possible configs of un-deployed VARIANT branches of everyday
// types (a fold built from one variant proves nothing about the others):
// - AWS::Kinesis::Stream ON_DEMAND: corpus only has PROVISIONED — on-demand
//   omits ShardCount and may echo on-demand-specific defaults.
// - AWS::SQS::Queue minimal FIFO: only FifoQueue declared — probes the
//   DeduplicationScope / FifoThroughputLimit / FifoThroughputScope echoes.
// - AWS::SQS::Queue full high-throughput FIFO: perMessageGroupId variant.
// - AWS::ECS::TaskDefinition NetworkMode=host: register-only (no service,
//   zero cost) — corpus covers only awsvpc and bridge.
// - AWS::Events::Rule cron(): corpus covers EventPattern and rate() only.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import { CfnRule } from "aws-cdk-lib/aws-events";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegStreamFifoMin");

new CfnStream(stack, "HuntOnDemandStream", {
  streamModeDetails: { streamMode: "ON_DEMAND" },
});

new CfnQueue(stack, "HuntFifoMin", {
  fifoQueue: true,
});

new CfnQueue(stack, "HuntFifoHighThroughput", {
  fifoQueue: true,
  contentBasedDeduplication: true,
  deduplicationScope: "messageGroup",
  fifoThroughputLimit: "perMessageGroupId",
});

new CfnTaskDefinition(stack, "HuntHostTaskDef", {
  family: "cdkrd-hunt-host-td",
  networkMode: "host",
  requiresCompatibilities: ["EC2"],
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/docker/library/busybox:stable",
      memory: 128,
    },
  ],
});

new CfnRule(stack, "HuntCronRule", {
  scheduleExpression: "cron(0 12 * * ? *)",
  state: "DISABLED",
});

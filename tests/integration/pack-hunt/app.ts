// False-positive probe (real AWS): barest forms of six common types that have
// only rich (or zero) fixture coverage — each declares ONLY what CFn requires,
// so the undeclared default surface is maximal:
// - Lambda LayerVersion (asset Content only; CompatibleRuntimes/Architectures
//   undeclared) — rich-only until now.
// - Lambda function on arm64 (the arm path's defaults were only ever deployed
//   inside rich fixtures).
// - CloudWatch Dashboard (DashboardBody only — also a JSON-string echo probe).
// - CloudWatch CompositeAlarm (AlarmName+AlarmRule; ActionsEnabled undeclared).
// - SNS FIFO topic (TopicName+FifoTopic; ContentBasedDeduplication /
//   FifoThroughputScope / ArchivePolicy undeclared) — only a rich KMS+dedup
//   FIFO fixture existed.
// - EventBridge Pipes (Source+Target+RoleArn; DesiredState + batch parameter
//   defaults undeclared) — rich-only until now.
// Nothing bills while idle. A first `check` (pre-record) must show ZERO
// [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnAlarm, CfnCompositeAlarm, CfnDashboard } from "aws-cdk-lib/aws-cloudwatch";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { Code, LayerVersion } from "aws-cdk-lib/aws-lambda";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";
import { CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Pack");

// --- Lambda LayerVersion, barest (Content only via asset) ---
new LayerVersion(stack, "HuntLayer", {
  code: Code.fromAsset("layer-src"),
});

// --- Lambda on arm64, barest ---
const fnRole = new Role(stack, "HuntArmRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
});
new CfnFunction(stack, "HuntArmFn", {
  code: { zipFile: "exports.handler = async () => {};" },
  handler: "index.handler",
  runtime: "nodejs20.x",
  architectures: ["arm64"],
  role: fnRole.roleArn,
});

// --- CloudWatch Dashboard, barest (JSON-string body echo probe) ---
new CfnDashboard(stack, "HuntDashboard", {
  dashboardBody: JSON.stringify({
    widgets: [
      {
        type: "text",
        x: 0,
        y: 0,
        width: 6,
        height: 3,
        properties: { markdown: "cdkrd hunt" },
      },
    ],
  }),
});

// --- CloudWatch metric alarm (named, for the composite rule) + composite ---
const alarm = new CfnAlarm(stack, "HuntAlarm", {
  alarmName: "CdkrdHunt0714PackChild",
  comparisonOperator: "GreaterThanThreshold",
  evaluationPeriods: 1,
  metricName: "NumberOfObjects",
  namespace: "AWS/S3",
  period: 86400,
  statistic: "Average",
  threshold: 100000,
});
const composite = new CfnCompositeAlarm(stack, "HuntComposite", {
  alarmName: "CdkrdHunt0714PackComposite",
  alarmRule: `ALARM("${alarm.alarmName}")`,
});
composite.addDependency(alarm);

// --- SNS FIFO topic, barest ---
new CfnTopic(stack, "HuntFifoTopic", {
  topicName: "CdkrdHunt0714Pack.fifo",
  fifoTopic: true,
});

// --- EventBridge Pipe, barest (SQS -> SQS) ---
const srcQueue = new CfnQueue(stack, "HuntPipeSrc", {});
const dstQueue = new CfnQueue(stack, "HuntPipeDst", {});
const pipeRole = new Role(stack, "HuntPipeRole", {
  assumedBy: new ServicePrincipal("pipes.amazonaws.com"),
});
pipeRole.addToPolicy(
  new PolicyStatement({
    actions: [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage",
    ],
    resources: [srcQueue.attrArn, dstQueue.attrArn],
  }),
);
const pipe = new CfnPipe(stack, "HuntPipe", {
  roleArn: pipeRole.roleArn,
  source: srcQueue.attrArn,
  target: dstQueue.attrArn,
});
pipe.node.addDependency(pipeRole);

app.synth();

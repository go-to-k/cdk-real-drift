// CDK app for the cdk-real-drift scheduler-rich false-positive integration test.
// EventBridge Scheduler (AWS::Scheduler::Schedule) is a common cron/rate replacement
// for CloudWatch Events rules. A schedule folds a FlexibleTimeWindow, a Target
// (Arn/RoleArn + defaulted RetryPolicy), and State into AWS's model — a clean
// `record`->`check` is a strong false-positive oracle. The target is an SQS queue
// (with a scheduler-assumable role) so the stack is self-contained.
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSchedulerRich");

const queue = new Queue(stack, "Target", { queueName: "cdkrd-scheduler-target" });
const role = new Role(stack, "SchedRole", {
  assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
});
queue.grantSendMessages(role);

new CfnSchedule(stack, "Schedule", {
  name: "cdkrd-schedule-rich",
  description: "cdkrd scheduler rich",
  state: "ENABLED",
  flexibleTimeWindow: { mode: "OFF" },
  scheduleExpression: "rate(1 hour)",
  target: { arn: queue.queueArn, roleArn: role.roleArn },
});

app.synth();

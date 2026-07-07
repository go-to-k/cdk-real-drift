// Minimal CDK app for the cdk-real-drift CloudWatch CompositeAlarm integration test.
//
// Stack CdkRealDriftIntegCompositeAlarmRich exercises AWS::CloudWatch::CompositeAlarm —
// the "alarm of alarms" pattern (combine several metric alarms with a boolean rule)
// that ops teams deploy for aggregate health. Two child metric alarms feed one
// composite alarm.
//
// A freshly deployed, un-mutated stack must produce ZERO [Potential Drift] on a first
// `check`. Every value AWS assigns undeclared (ActionsEnabled default true, etc.) must
// fold to atDefault.
import { App, Duration, Stack } from "aws-cdk-lib";
import {
  Alarm,
  AlarmRule,
  ComparisonOperator,
  CompositeAlarm,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCompositeAlarmRich");

const cpu = new Alarm(stack, "CpuAlarm", {
  metric: new Metric({
    namespace: "AWS/EC2",
    metricName: "CPUUtilization",
    period: Duration.minutes(5),
    statistic: "Average",
  }),
  threshold: 80,
  evaluationPeriods: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
});

const net = new Alarm(stack, "NetAlarm", {
  metric: new Metric({
    namespace: "AWS/EC2",
    metricName: "NetworkIn",
    period: Duration.minutes(5),
    statistic: "Average",
  }),
  threshold: 1_000_000,
  evaluationPeriods: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
});

new CompositeAlarm(stack, "Composite", {
  alarmRule: AlarmRule.anyOf(cpu, net),
  compositeAlarmName: "cdkrd-integ-composite",
  actionsSuppressor: cpu,
  actionsSuppressorExtensionPeriod: Duration.minutes(1),
  actionsSuppressorWaitPeriod: Duration.minutes(1),
});

app.synth();

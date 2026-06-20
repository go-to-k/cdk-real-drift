// CDK app for the cdk-real-drift CloudWatch Dashboard false-positive test.
// A Dashboard's entire content is a single DashboardBody JSON string in the
// template; CloudWatch re-serializes and default-fills that JSON server-side
// (injecting "region", widget "view"/"stacked" defaults, metric stat/period
// defaults), so a naive string compare of declared-vs-live body is a classic
// false-positive trap. A freshly deployed + recorded dashboard with NO
// out-of-band change MUST report CLEAN.
import { App, Duration, Stack } from "aws-cdk-lib";
import {
  Dashboard,
  GraphWidget,
  Metric,
  SingleValueWidget,
  TextWidget,
} from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDashboardRich");

const invocations = new Metric({
  namespace: "AWS/Lambda",
  metricName: "Invocations",
  statistic: "Sum",
  period: Duration.minutes(5),
});
const errors = new Metric({
  namespace: "AWS/Lambda",
  metricName: "Errors",
  statistic: "Sum",
  period: Duration.minutes(5),
});

new Dashboard(stack, "Dash", {
  dashboardName: "cdkrd-dashboard-rich",
  widgets: [
    [new TextWidget({ markdown: "# cdkrd dashboard-rich", width: 24, height: 2 })],
    [
      new GraphWidget({ title: "Invocations", left: [invocations], width: 12, height: 6 }),
      new SingleValueWidget({ title: "Errors", metrics: [errors], width: 12, height: 6 }),
    ],
  ],
});

app.synth();

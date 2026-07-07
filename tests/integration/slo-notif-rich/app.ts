// CDK app for the cdk-real-drift SLO + CodeStar NotificationRule false-positive
// integration test (bug hunt). Two common, serverless, cheap observability/CI types
// with NO prior coverage:
//
//   AWS::ApplicationSignals::ServiceLevelObjective — a period-based SLO. We DECLARE
//   only the required Sli (metric + threshold + comparison) and deliberately OMIT
//   Goal and Description, so AWS fills them at creation: Description -> "No description",
//   Goal -> a default rolling-7-day interval with AttainmentGoal 99 (and a
//   WarningThreshold). Every such AWS-assigned undeclared default must fold to
//   atDefault on a first `check` — anything surfacing is a fold gap. The metric also
//   carries two Dimensions (an insertionOrder:false array) to probe reorder FPs.
//
//   AWS::CodeStarNotifications::NotificationRule — on a CodeBuild project, targeting
//   an SNS topic. Status defaults to ENABLED and EventTypeIds is an unordered set;
//   both are FP-prone if AWS echoes them back normalized/reordered.
import { App, Stack } from "aws-cdk-lib";
import { CfnServiceLevelObjective } from "aws-cdk-lib/aws-applicationsignals";
import { CfnNotificationRule } from "aws-cdk-lib/aws-codestarnotifications";
import { Project, BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSloNotif");

// Period-based SLO over a plain CloudWatch metric. Goal + Description omitted on
// purpose so AWS materializes its defaults undeclared.
new CfnServiceLevelObjective(stack, "Slo", {
  name: "cdkrd-slo-lambda-errors",
  sli: {
    sliMetric: {
      metricDataQueries: [
        {
          id: "m1",
          returnData: true,
          metricStat: {
            metric: {
              namespace: "AWS/Lambda",
              metricName: "Errors",
              dimensions: [
                { name: "FunctionName", value: "cdkrd-slo-fn" },
                { name: "Resource", value: "cdkrd-slo-fn:live" },
              ],
            },
            period: 60,
            stat: "Sum",
          },
        },
      ],
    },
    metricThreshold: 5,
    comparisonOperator: "LessThanOrEqualTo",
  },
});

// CodeBuild project + SNS topic to hang a NotificationRule on.
const project = new Project(stack, "Proj", {
  buildSpec: BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo hello"] } },
  }),
});
const topic = new Topic(stack, "NotifTopic");

new CfnNotificationRule(stack, "Notif", {
  name: "cdkrd-notif-rule",
  detailType: "BASIC",
  resource: project.projectArn,
  eventTypeIds: [
    "codebuild-project-build-state-succeeded",
    "codebuild-project-build-state-failed",
  ],
  targets: [{ targetType: "SNS", targetAddress: topic.topicArn }],
});

app.synth();

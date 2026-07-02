// CDK app for the cdk-real-drift aps-rich false-positive integration test.
// Amazon Managed Service for Prometheus (zero corpus coverage; free while idle):
// - AWS::APS::Workspace with Alias, AlertManagerDefinition (a YAML STRING blob —
//   the object<->string / reformat normalization FP class) and a vended-logs
//   LoggingConfiguration.
// - AWS::APS::RuleGroupsNamespace whose Data is a Prometheus rules YAML STRING.
// A clean `record`->`check` is the FP oracle; verify-detect.sh mutates the
// mutable Workspace Alias out of band for the FN half.
import { App, CfnOutput, Stack } from "aws-cdk-lib";
import { CfnRuleGroupsNamespace, CfnWorkspace } from "aws-cdk-lib/aws-aps";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegApsRich");

const alertTopic = new Topic(stack, "HuntAlertTopic", {
  topicName: "cdkrd-hunt-aps-alerts",
});

const logGroup = new LogGroup(stack, "HuntApsLogs", {
  logGroupName: "/aws/vendedlogs/prometheus/cdkrd-hunt",
  retention: RetentionDays.ONE_DAY,
});

const alertManagerDefinition = [
  "alertmanager_config: |",
  "  route:",
  "    receiver: 'default'",
  "  receivers:",
  "    - name: 'default'",
  "      sns_configs:",
  `        - topic_arn: '${alertTopic.topicArn}'`,
  "          sigv4:",
  `            region: '${stack.region}'`,
  "          message: '{{ .CommonAnnotations.summary }}'",
  "",
].join("\n");

const workspace = new CfnWorkspace(stack, "HuntWorkspace", {
  alias: "cdkrd-hunt-aps",
  alertManagerDefinition,
  loggingConfiguration: { logGroupArn: logGroup.logGroupArn },
  tags: [{ key: "Name", value: "cdkrd-hunt-aps" }],
});

new CfnRuleGroupsNamespace(stack, "HuntRules", {
  workspace: workspace.attrArn,
  name: "cdkrd-hunt-rules",
  data: [
    "groups:",
    "  - name: cdkrd-hunt",
    "    rules:",
    "      - record: job:up:sum",
    "        expr: sum(up) by (job)",
    "      - alert: CdkrdHuntDown",
    "        expr: up == 0",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: target down",
    "",
  ].join("\n"),
});

new CfnOutput(stack, "WorkspaceId", { value: workspace.attrWorkspaceId });

app.synth();

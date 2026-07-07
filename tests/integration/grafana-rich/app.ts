// CDK app for the cdk-real-drift grafana-rich false-positive integration test.
// Amazon Managed Grafana (AWS::Grafana::Workspace) is a common managed-observability
// dashboard service. A workspace folds a large set of AWS-assigned defaults —
// GrafanaVersion (AWS expands to a concrete patch), Status, Endpoint, Creation
// timestamp, DataSources, NotificationDestinations, and the SERVICE_MANAGED
// permission model — none declared. A clean `record`->`check` is a strong
// false-positive oracle for those undeclared first-run defaults.
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnWorkspace } from "aws-cdk-lib/aws-grafana";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGrafanaRich");

const role = new Role(stack, "GrafanaRole", {
  assumedBy: new ServicePrincipal("grafana.amazonaws.com"),
});

new CfnWorkspace(stack, "Workspace", {
  name: "cdkrd-grafana-rich",
  description: "cdkrd grafana rich",
  accountAccessType: "CURRENT_ACCOUNT",
  authenticationProviders: ["SAML"],
  permissionType: "SERVICE_MANAGED",
  roleArn: role.roleArn,
  dataSources: ["CLOUDWATCH", "PROMETHEUS"],
  notificationDestinations: ["SNS"],
});

app.synth();

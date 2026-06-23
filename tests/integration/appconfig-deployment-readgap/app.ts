// AppConfig stack exercising the 3-segment COMPOSITE-identifier types not yet covered:
// AWS::AppConfig::HostedConfigurationVersion ([ApplicationId, ConfigurationProfileId,
// VersionNumber]) and AWS::AppConfig::Deployment ([ApplicationId, EnvironmentId,
// DeploymentNumber]). Like the PR #346 probe, this confirms whether their declared CC
// read works with the bare CFn physical id or is a ValidationException read-gap needing
// a CC_IDENTIFIER_ADAPTERS entry. AppConfig has no infra (cheap). A clean record->check
// is also the FP oracle.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnConfigurationProfile,
  CfnDeployment,
  CfnDeploymentStrategy,
  CfnEnvironment,
  CfnHostedConfigurationVersion,
} from "aws-cdk-lib/aws-appconfig";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAppconfigDeploymentReadgap");

const application = new CfnApplication(stack, "Cfg", { name: "cdkrd-readgap-app" });
const env = new CfnEnvironment(stack, "CfgEnv", {
  applicationId: application.ref,
  name: "prod",
});
const profile = new CfnConfigurationProfile(stack, "CfgProfile", {
  applicationId: application.ref,
  name: "flags",
  locationUri: "hosted",
});
const version = new CfnHostedConfigurationVersion(stack, "CfgVersion", {
  applicationId: application.ref,
  configurationProfileId: profile.ref,
  contentType: "application/json",
  content: JSON.stringify({ feature: { enabled: true } }),
});
const strategy = new CfnDeploymentStrategy(stack, "CfgStrategy", {
  name: "cdkrd-fast",
  deploymentDurationInMinutes: 0,
  growthFactor: 100,
  replicateTo: "NONE",
  finalBakeTimeInMinutes: 0,
});
new CfnDeployment(stack, "CfgDeployment", {
  applicationId: application.ref,
  environmentId: env.ref,
  configurationProfileId: profile.ref,
  configurationVersion: version.ref,
  deploymentStrategyId: strategy.ref,
});

app.synth();

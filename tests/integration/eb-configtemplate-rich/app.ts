// CDK app for the cdk-real-drift Elastic Beanstalk ConfigurationTemplate OptionSettings
// fold test. A ConfigurationTemplate provisions NOTHING (no EC2/ELB — it is just a saved
// config), so this stack is cheap and fast. AWS materializes the FULL resolved option set
// (~51 entries) from the handful the template declares; every undeclared extra must fold to
// atDefault (zero [Potential Drift] on a first check). Two templates — SingleInstance and
// LoadBalanced — pin which option defaults are env-type CONTEXT-DEPENDENT (e.g. MaxSize:
// SingleInstance=1 vs LoadBalanced=4) so the fold can DERIVE those from EnvironmentType.
import { App, CfnOutput, Stack } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnConfigurationTemplate,
} from "aws-cdk-lib/aws-elasticbeanstalk";

const SOLUTION_STACK = "64bit Amazon Linux 2023 v4.13.3 running Docker";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEbConfigTemplate");

const application = new CfnApplication(stack, "EbApp", {
  applicationName: "cdkrd-hunt-ebct-app",
});

const single = new CfnConfigurationTemplate(stack, "EbTemplateSingle", {
  applicationName: application.applicationName!,
  solutionStackName: SOLUTION_STACK,
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "SingleInstance",
    },
  ],
});
single.addDependency(application);

const balanced = new CfnConfigurationTemplate(stack, "EbTemplateBalanced", {
  applicationName: application.applicationName!,
  solutionStackName: SOLUTION_STACK,
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "LoadBalanced",
    },
  ],
});
balanced.addDependency(application);

new CfnOutput(stack, "ApplicationName", { value: application.applicationName! });

app.synth();

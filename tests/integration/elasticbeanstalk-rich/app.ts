// CDK app for the cdk-real-drift Elastic Beanstalk false-positive test. Elastic
// Beanstalk is a classic managed-PaaS choice, and the `aws-elasticbeanstalk` L1
// module emits three resource types cdkrd has never exercised as live reads:
// Application, ConfigurationTemplate, and Environment. All three carry AWS-filled
// option-setting surface (the ConfigurationTemplate/Environment OptionSettings AWS
// materializes at create — see #493), plus create-only identifiers. A freshly
// deployed + recorded stack with NO out-of-band change MUST report CLEAN, and a
// check BEFORE record must fold every AWS-assigned default to atDefault (zero
// [Potential Drift]).
import { App, CfnOutput, Stack } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnConfigurationTemplate,
  CfnEnvironment,
} from "aws-cdk-lib/aws-elasticbeanstalk";
import { CfnInstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

// Pinned solution stack (Docker on AL2023) — a SingleInstance env keeps the deploy
// to one t3.micro with no load balancer, so it is cheap and quick to tear down.
const SOLUTION_STACK = "64bit Amazon Linux 2023 v4.13.3 running Docker";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEbRich");

const instanceRole = new Role(stack, "EbInstanceRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  managedPolicies: [
    { managedPolicyArn: "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier" },
  ],
});
const instanceProfile = new CfnInstanceProfile(stack, "EbInstanceProfile", {
  roles: [instanceRole.roleName],
});

const application = new CfnApplication(stack, "EbApp", {
  applicationName: "cdkrd-hunt-eb-app",
  description: "cdkrd bug-hunt Elastic Beanstalk application",
});

const template = new CfnConfigurationTemplate(stack, "EbTemplate", {
  applicationName: application.applicationName!,
  solutionStackName: SOLUTION_STACK,
  description: "cdkrd bug-hunt configuration template",
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "SingleInstance",
    },
    {
      namespace: "aws:autoscaling:launchconfiguration",
      optionName: "InstanceType",
      value: "t3.micro",
    },
  ],
});
template.addDependency(application);

const environment = new CfnEnvironment(stack, "EbEnv", {
  applicationName: application.applicationName!,
  environmentName: "cdkrd-hunt-eb-env",
  solutionStackName: SOLUTION_STACK,
  description: "cdkrd bug-hunt environment",
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "SingleInstance",
    },
    {
      namespace: "aws:autoscaling:launchconfiguration",
      optionName: "IamInstanceProfile",
      value: instanceProfile.ref,
    },
    {
      namespace: "aws:autoscaling:launchconfiguration",
      optionName: "InstanceType",
      value: "t3.micro",
    },
    {
      namespace: "aws:elasticbeanstalk:application:environment",
      optionName: "GREETING",
      value: "hello-from-cdkrd",
    },
  ],
});
environment.addDependency(application);

new CfnOutput(stack, "EnvironmentName", { value: environment.environmentName! });
new CfnOutput(stack, "ApplicationName", { value: application.applicationName! });

app.synth();

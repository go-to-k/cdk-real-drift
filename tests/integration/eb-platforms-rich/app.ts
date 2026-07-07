// CDK app for the cdk-real-drift Elastic Beanstalk multi-platform + Environment-read test.
// Two dimensions the earlier EB rounds (#598/#600/#603) did not cover:
//   1. ConfigurationTemplates on NON-Docker platforms (Python / Node.js / Corretto / PHP) —
//      the OptionSettings default tables were pinned only from the Docker platform, so a
//      different platform may materialize options the tables miss (they must still fold to
//      atDefault: zero potential drift). ConfigurationTemplates provision NOTHING → cheap.
//   2. An Environment whose OptionSettings is now read back via the DescribeConfigurationSettings
//      SDK supplement (was a writeOnly readGap) — a declared option must be VERIFIED and the
//      service-filled extras must fold.
import { App, CfnOutput, Stack } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnConfigurationTemplate,
  CfnEnvironment,
} from "aws-cdk-lib/aws-elasticbeanstalk";
import { CfnInstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const DOCKER = "64bit Amazon Linux 2023 v4.13.3 running Docker";
const PLATFORMS: Record<string, string> = {
  Python: "64bit Amazon Linux 2023 v4.13.3 running Python 3.13",
  Node: "64bit Amazon Linux 2023 v6.11.3 running Node.js 22",
  Corretto: "64bit Amazon Linux 2023 v4.12.3 running Corretto 21",
  Php: "64bit Amazon Linux 2023 v4.13.3 running PHP 8.3",
};

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEbPlatforms");

const application = new CfnApplication(stack, "EbApp", {
  applicationName: "cdkrd-hunt-ebpf-app",
});

// One ConfigurationTemplate per non-Docker platform (LoadBalanced, to exercise the richest
// option surface). Cheap: a template launches nothing.
for (const [name, solutionStackName] of Object.entries(PLATFORMS)) {
  const t = new CfnConfigurationTemplate(stack, `EbTemplate${name}`, {
    applicationName: application.applicationName!,
    solutionStackName,
    optionSettings: [
      {
        namespace: "aws:elasticbeanstalk:environment",
        optionName: "EnvironmentType",
        value: "LoadBalanced",
      },
    ],
  });
  t.addDependency(application);
}

// A Docker SingleInstance Environment whose OptionSettings is read back via the supplement.
const instanceRole = new Role(stack, "EbInstanceRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  managedPolicies: [
    { managedPolicyArn: "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier" },
  ],
});
const instanceProfile = new CfnInstanceProfile(stack, "EbInstanceProfile", {
  roles: [instanceRole.roleName],
});
const environment = new CfnEnvironment(stack, "EbEnv", {
  applicationName: application.applicationName!,
  environmentName: "cdkrd-hunt-ebpf-env",
  solutionStackName: DOCKER,
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
      namespace: "aws:elasticbeanstalk:application:environment",
      optionName: "GREETING",
      value: "hello-from-cdkrd",
    },
    {
      // a declared, readable, mutable option — the FN target for the supplement read
      namespace: "aws:elasticbeanstalk:cloudwatch:logs",
      optionName: "StreamLogs",
      value: "true",
    },
  ],
});
environment.addDependency(application);

new CfnOutput(stack, "ApplicationName", { value: application.applicationName! });
new CfnOutput(stack, "EnvironmentName", { value: environment.environmentName! });

app.synth();

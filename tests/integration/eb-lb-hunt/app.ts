// 2026-08-10 hunt: a LIVE LoadBalanced Elastic Beanstalk Environment — every
// existing Environment fixture is SingleInstance (the LoadBalanced shape was only
// ever deployed as a ConfigurationTemplate, which is where the derived rows were
// pinned). A live LoadBalanced env materializes the `aws:elb:*` / LoadBalancerType
// option families the SingleInstance envs never read back — the
// `aws:elasticbeanstalk:environment|LoadBalancerType: 'classic'` flat constant and
// the ~20 `aws:elb:*` EB_OPTION_DEFAULTS rows are the suspected gap.
// First `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnEnvironment,
} from "aws-cdk-lib/aws-elasticbeanstalk";
import { CfnInstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const SOLUTION_STACK = "64bit Amazon Linux 2023 v4.13.3 running Docker";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0810EbLb");

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
  applicationName: "cdkrd-0810-eblb-app",
});

const environment = new CfnEnvironment(stack, "EbEnv", {
  applicationName: application.applicationName!,
  environmentName: "cdkrd-0810-eblb-env",
  solutionStackName: SOLUTION_STACK,
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "LoadBalanced",
    },
    {
      namespace: "aws:autoscaling:launchconfiguration",
      optionName: "InstanceType",
      value: "t3.micro",
    },
    {
      namespace: "aws:autoscaling:launchconfiguration",
      optionName: "IamInstanceProfile",
      value: instanceProfile.ref,
    },
  ],
});
environment.addDependency(application);

app.synth();

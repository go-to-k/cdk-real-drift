// Variant-row probe (real AWS): EB_INSTANCE_TYPES_DEFAULT_BY_ARCH['arm64']
// ({t4g.micro, t4g.small}) was pinned FROM THE EB DOCS — the x86_64 sibling is
// corpus-harvested but no arm64 environment ever ran live (the #1664 mirrored-
// row class). Deploy a SingleInstance env declaring ONLY
// aws:ec2:instances|SupportedArchitectures=arm64 (no InstanceTypes /
// InstanceType), and assert the first check is CLEAN — if AWS's real arm64
// default instance-type list differs from the docs pin, it first-run-FPs here.
// The solution stack name moves over time, so verify.sh resolves the latest
// Docker AL2023 stack and passes it via EB_STACK.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnApplication, CfnEnvironment } from "aws-cdk-lib/aws-elasticbeanstalk";
import { CfnInstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const solutionStack = process.env.EB_STACK;
if (!solutionStack) throw new Error("EB_STACK env is required (set by verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722EbArm");

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
  applicationName: "cdkrd-hunt0722-ebarm-app",
});

const environment = new CfnEnvironment(stack, "EbEnv", {
  applicationName: application.applicationName!,
  environmentName: "cdkrd-hunt0722-ebarm-env",
  solutionStackName: solutionStack,
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
      namespace: "aws:ec2:instances",
      optionName: "SupportedArchitectures",
      value: "arm64",
    },
  ],
});
environment.addDependency(application);

app.synth();

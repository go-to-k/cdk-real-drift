// CDK app for the cdk-real-drift EC2 LaunchTemplate SDK-override test. A
// LaunchTemplate is one of the most-deployed EC2 building blocks (every Auto
// Scaling Group, EKS managed node group, and Spot fleet uses one). Its entire
// `LaunchTemplateData` body is writeOnly in the CloudFormation registry schema,
// so Cloud Control returns only ids/version numbers — the data was a permanent
// readGap until the readEc2LaunchTemplate SDK override (DescribeLaunchTemplate-
// Versions). It is metadata only — no instance, VPC, or security group — so it
// deploys near-instantly.
//
// A freshly deployed + recorded LaunchTemplate MUST be CLEAN: the override reads
// the default version's data, which AWS returns faithfully (no default injection),
// so the declared LaunchTemplateData should match the live read exactly.
import { App, Stack } from "aws-cdk-lib";
import { CfnLaunchTemplate } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEc2LaunchTemplateRich");

new CfnLaunchTemplate(stack, "LaunchTemplate", {
  launchTemplateName: "cdkrd-integ-launchtemplate",
  launchTemplateData: {
    instanceType: "t3.micro",
    blockDeviceMappings: [
      {
        deviceName: "/dev/xvda",
        ebs: { volumeSize: 8, volumeType: "gp3", encrypted: true },
      },
      {
        deviceName: "/dev/xvdb",
        ebs: { volumeSize: 20, volumeType: "gp3", deleteOnTermination: true },
      },
    ],
    metadataOptions: {
      httpTokens: "required",
      httpPutResponseHopLimit: 2,
      httpEndpoint: "enabled",
    },
    monitoring: { enabled: true },
    creditSpecification: { cpuCredits: "standard" },
    tagSpecifications: [
      {
        resourceType: "instance",
        tags: [
          { key: "Name", value: "cdkrd-lt-instance" },
          { key: "Tier", value: "web" },
        ],
      },
    ],
  },
});

app.synth();

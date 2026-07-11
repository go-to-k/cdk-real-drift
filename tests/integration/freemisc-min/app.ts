// CDK app for the cdk-real-drift freemisc-min false-positive integration test.
// BAREST-possible configs of free/instant zero-coverage types:
// - AWS::MSK::Configuration: supplement reader exists (#508) but no live
//   deploy/corpus ever exercised it (ServerProperties round-trip + defaults).
// - AWS::CloudFormation::StackSet: SELF_MANAGED with zero instances —
//   OperationPreferences / capabilities echoes unknown.
// - AWS::ImageBuilder::Component + InfrastructureConfiguration: enterprise AMI
//   pipeline staples, zero coverage; InfraConfig materializes instance-type /
//   metadata defaults.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnStackSet } from "aws-cdk-lib/aws-cloudformation";
import { CfnInstanceProfile, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnComponent, CfnInfrastructureConfiguration } from "aws-cdk-lib/aws-imagebuilder";
import { CfnConfiguration } from "aws-cdk-lib/aws-msk";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegFreeMiscMin");

new CfnConfiguration(stack, "HuntMskConfig", {
  name: "cdkrd-hunt-msk-config",
  serverProperties: "auto.create.topics.enable=false\nlog.retention.hours=168\n",
});

new CfnStackSet(stack, "HuntStackSet", {
  stackSetName: "cdkrd-hunt-stackset",
  permissionModel: "SELF_MANAGED",
  templateBody: JSON.stringify({
    Resources: {
      HuntWaitHandle: { Type: "AWS::CloudFormation::WaitConditionHandle" },
    },
  }),
});

const component = new CfnComponent(stack, "HuntComponent", {
  name: "cdkrd-hunt-component",
  platform: "Linux",
  version: "1.0.0",
  data: [
    "name: cdkrd-hunt-noop",
    "description: cdkrd hunt noop component",
    "schemaVersion: 1.0",
    "phases:",
    "  - name: build",
    "    steps:",
    "      - name: Noop",
    "        action: ExecuteBash",
    "        inputs:",
    "          commands:",
    "            - echo noop",
    "",
  ].join("\n"),
});

const ibRole = new Role(stack, "HuntIbRole", {
  assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
});
const ibProfile = new CfnInstanceProfile(stack, "HuntIbProfile", {
  instanceProfileName: "cdkrd-hunt-ib-profile",
  roles: [ibRole.roleName],
});

const infra = new CfnInfrastructureConfiguration(stack, "HuntIbInfra", {
  name: "cdkrd-hunt-ib-infra",
  instanceProfileName: "cdkrd-hunt-ib-profile",
});
infra.addDependency(ibProfile);
void component;

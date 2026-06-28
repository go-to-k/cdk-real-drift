// CDK app for the cdk-real-drift SecurityGroup ingress revert-gap test.
//
// AWS::EC2::SecurityGroup inline SecurityGroupIngress is the canonical "someone
// opened/changed a rule in the console" scenario — extremely common. Rules are
// CC-readable (a change is DETECTED), but the EC2 CC handler must translate a
// rule-array patch into Authorize*/Revoke*SecurityGroup* calls, which is a fiddly
// path. This fixture verifies that reverting a removed/changed ingress rule
// actually re-applies it in AWS (detect -> revert -> CLEAN -> live restored).
import { App, Stack } from "aws-cdk-lib";
import { CfnSecurityGroup } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSgIngressRevert");

new CfnSecurityGroup(stack, "Sg", {
  groupDescription: "cdkrd sg ingress revert probe",
  securityGroupIngress: [
    {
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrIp: "10.0.0.0/16",
      description: "ssh from vpc",
    },
  ],
});

app.synth();

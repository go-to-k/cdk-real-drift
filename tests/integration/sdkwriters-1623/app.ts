// #1623 live verify: the CodeBuild Project / MediaConvert Queue SDK writers —
// detection already worked (revconv4-hunt), revert said "type not revertable
// yet". Barest forms with the probed scalars UNDECLARED so the out-of-band
// mutation -> detect -> revert -> live-default cycle exercises the writers.
// Rider probe: a STANDALONE instance-target TCP TargetGroup (no LB needed for
// its attribute bag) — the #1626 hunt proved the ip-target default
// (preserve_client_ip=false); the instance-target inverse ("true") was left
// unproven and is a suspected latent first-run FP.
import { App, Fn, Stack, Tags } from "aws-cdk-lib";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnQueue as CfnMcQueue } from "aws-cdk-lib/aws-mediaconvert";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "Cdkrd1623Writers");

const cbRole = new Role(stack, "W1623CbRole", {
  assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
});
new CfnProject(stack, "W1623CbProject", {
  name: "cdkrd-1623-cb",
  serviceRole: cbRole.roleArn,
  source: { type: "NO_SOURCE", buildSpec: '{"version":"0.2","phases":{}}' },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    computeType: "BUILD_GENERAL1_SMALL",
    image: "aws/codebuild/standard:7.0",
  },
});

new CfnMcQueue(stack, "W1623McQueue", { name: "cdkrd-1623-mcq" });

// Standalone instance-target TCP target group (attribute-bag probe, no LB).
const vpc = new CfnVPC(stack, "W1623Vpc", { cidrBlock: "10.2.0.0/24" });
new CfnSubnet(stack, "W1623Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.2.0.0/25",
  availabilityZone: Fn.select(0, Fn.getAzs()),
});
new CfnTargetGroup(stack, "W1623InstanceTg", {
  protocol: "TCP",
  port: 80,
  targetType: "instance",
  vpcId: vpc.ref,
});

app.synth();

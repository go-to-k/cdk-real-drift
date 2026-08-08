// CDK app for the cdk-real-drift cdstyle-hunt integration test (2026-08-09 hunt).
// Settles the #1723 open determination: the CodeDeploy DeploymentGroup
// DeploymentStyle whole-object KNOWN_DEFAULTS pin is revert-UNPROVEN because the
// off-default shape (WITH_TRAFFIC_CONTROL) is unreachable on a barest Server DG —
// UpdateDeploymentGroup rejects it without LoadBalancerInfo. A STANDALONE target
// group (no load balancer — a TG is free and needs only a VPC) makes the shape
// reachable: verify.sh OOB-attaches WITH_TRAFFIC_CONTROL + targetGroupInfoList,
// asserts detection, then asserts revert converges BOTH the style flip and the
// appeared LoadBalancerInfo (a suspected REVERT_COMPANION_REMOVES pairing — the
// style default may be rejected while the LB info echo remains).
// Also carries the first live E2E of `check --pre-deploy` (#727): an SSM
// parameter for the OOB declared-drift probe, and a context-gated (-c extra=1)
// second parameter as the pending-creation (not-yet-deployed) local resource.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApplication as CfnCodeDeployApplication,
  CfnDeploymentGroup,
} from "aws-cdk-lib/aws-codedeploy";
import { CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnParameter } from "aws-cdk-lib/aws-ssm";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntCdStyle0809");

// Standalone TG (control-plane only, free): the UpdateDeploymentGroup
// targetGroupInfoList references it by NAME.
const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.61.0.0/16" });
new CfnTargetGroup(stack, "Tg", {
  name: "cdkrd-hunt-tg-0809",
  protocol: "HTTP",
  port: 80,
  vpcId: vpc.ref,
  targetType: "instance",
});

const cdApp = new CfnCodeDeployApplication(stack, "CdApp", {
  applicationName: "cdkrd-hunt-cd-0809b",
  computePlatform: "Server",
});
const cdRole = new Role(stack, "CdServiceRole", {
  assumedBy: new ServicePrincipal("codedeploy.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSCodeDeployRole")],
});
// Barest Server deployment group: DeploymentStyle / DeploymentConfigName /
// LoadBalancerInfo all stay UNDECLARED — the #1723 fold + OOB flip surface.
new CfnDeploymentGroup(stack, "CdGroup", {
  applicationName: cdApp.ref,
  deploymentGroupName: "cdkrd-hunt-dg-0809b",
  serviceRoleArn: cdRole.roleArn,
});

// --pre-deploy probes: a declared parameter the verify.sh mutates out of band …
new CfnParameter(stack, "PreParam", {
  name: "cdkrd-hunt-pval-0809",
  type: "String",
  value: "v1",
});
// … and a pending-creation resource that exists ONLY in the local synth
// (never deployed): `check --pre-deploy -c extra=1` must count it as
// "not yet deployed" info, not a coverage gap / skip.
if (app.node.tryGetContext("extra") === "1") {
  new CfnParameter(stack, "ExtraParam", {
    name: "cdkrd-hunt-extra-0809",
    type: "String",
    value: "x1",
  });
}

app.synth();

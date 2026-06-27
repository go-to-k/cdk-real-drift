// CDK app for the cdk-real-drift ASG INLINE LifecycleHookSpecificationList FP test.
// The existing autoscaling-lifecyclehook-rich fixture covers the STANDALONE
// AWS::AutoScaling::LifecycleHook resource; the ASG's own inline
// `LifecycleHookSpecificationList` (a SET of hooks the CFn schema marks
// insertionOrder:false) was never probed. Its element key is `LifecycleHookName`,
// which is NOT one of cdkrd's IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name),
// so a keyed canonicalizer cannot align a reorder. The two hooks are declared in
// DELIBERATELY non-sorted order by name; if EC2 Auto Scaling echoes the list sorted
// (the pattern its sibling MetricsCollection/NotificationConfigurations sets follow),
// a positional compare false-flags every field of every shifted hook as declared
// drift on a freshly recorded ASG. desiredCapacity 0 (no instances) so it is cheap.
// A clean record -> check MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  Vpc,
  InstanceType,
  InstanceClass,
  InstanceSize,
  MachineImage,
  SubnetType,
  LaunchTemplate,
} from "aws-cdk-lib/aws-ec2";
import { AutoScalingGroup, CfnAutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAsgLifecycleHookInline");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const launchTemplate = new LaunchTemplate(stack, "Lt", {
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: MachineImage.latestAmazonLinux2023(),
});
const asg = new AutoScalingGroup(stack, "Asg", {
  vpc,
  launchTemplate,
  minCapacity: 0,
  maxCapacity: 2,
  desiredCapacity: 0,
});

const cfnAsg = asg.node.defaultChild as CfnAutoScalingGroup;
// Two lifecycle hooks declared non-alphabetically by LifecycleHookName (zeta before alpha).
cfnAsg.lifecycleHookSpecificationList = [
  {
    lifecycleHookName: "zeta-terminate",
    lifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
    defaultResult: "CONTINUE",
    heartbeatTimeout: 300,
  },
  {
    lifecycleHookName: "alpha-launch",
    lifecycleTransition: "autoscaling:EC2_INSTANCE_LAUNCHING",
    defaultResult: "CONTINUE",
    heartbeatTimeout: 300,
  },
];

app.synth();

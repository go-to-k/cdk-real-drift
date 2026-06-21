// CDK app for the cdk-real-drift Auto Scaling lifecycle-hook false-positive +
// read-gap test. A lifecycle hook on an Auto Scaling group is a common pattern
// (drain/bootstrap on launch/terminate), but a DECLARED AWS::AutoScaling::
// LifecycleHook has never been read via the normal CC path. Its CC primaryIdentifier
// is the composite [AutoScalingGroupName, LifecycleHookName] while the CFn physical
// id is the bare LifecycleHookName, so without a CC_IDENTIFIER_ADAPTERS entry it is
// silently `skipped`. The ASG is sized to zero instances (nothing launches). A
// freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN —
// and the hook MUST be read (skipped=0).
import { App, Stack } from "aws-cdk-lib";
import { AutoScalingGroup, CfnLifecycleHook } from "aws-cdk-lib/aws-autoscaling";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  LaunchTemplate,
  MachineImage,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAutoScalingLifecycleHookRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

// Launch CONFIGURATIONS are no longer creatable in new accounts; the ASG must use a
// launch template.
const launchTemplate = new LaunchTemplate(stack, "Lt", {
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: MachineImage.latestAmazonLinux2023(),
});

const asg = new AutoScalingGroup(stack, "Asg", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  launchTemplate,
  minCapacity: 0,
  maxCapacity: 1,
});

new CfnLifecycleHook(stack, "Hook", {
  autoScalingGroupName: asg.autoScalingGroupName,
  lifecycleHookName: "cdkrd-launch-hook",
  lifecycleTransition: "autoscaling:EC2_INSTANCE_LAUNCHING",
  defaultResult: "CONTINUE",
  heartbeatTimeout: 300,
});

app.synth();

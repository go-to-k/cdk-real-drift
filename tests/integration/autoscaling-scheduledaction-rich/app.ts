// CDK app for the cdk-real-drift Auto Scaling scheduled-action false-positive +
// read-gap test. Scheduled scaling is a common cost pattern, but a DECLARED
// AWS::AutoScaling::ScheduledAction has never been read via the normal CC path. Its
// CC primaryIdentifier is the composite [ScheduledActionName, AutoScalingGroupName]
// — CHILD-first, the REVERSE of the sibling LifecycleHook ([AutoScalingGroupName,
// LifecycleHookName] parent-first) — while the CFn physical id is the bare
// ScheduledActionName, so without a CC_IDENTIFIER_ADAPTERS entry it is silently
// `skipped`. The ASG is sized to zero instances (nothing launches). A freshly
// deployed + recorded stack with NO out-of-band change MUST report CLEAN — and the
// scheduled action MUST be read (skipped=0).
import { App, Stack } from "aws-cdk-lib";
import { AutoScalingGroup, CfnScheduledAction } from "aws-cdk-lib/aws-autoscaling";
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
const stack = new Stack(app, "CdkRealDriftIntegAutoScalingScheduledActionRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const launchTemplate = new LaunchTemplate(stack, "Lt", {
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: MachineImage.latestAmazonLinux2023(),
});

const asg = new AutoScalingGroup(stack, "Asg", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  launchTemplate,
  minCapacity: 0,
  maxCapacity: 2,
});

new CfnScheduledAction(stack, "Schedule", {
  autoScalingGroupName: asg.autoScalingGroupName,
  scheduledActionName: "cdkrd-scale-up",
  recurrence: "0 9 * * MON-FRI",
  minSize: 1,
  maxSize: 2,
  desiredCapacity: 1,
  timeZone: "UTC",
});

app.synth();

// cdk-real-drift — removed-collection REVERT test (issue #421 TASK 2) on an EC2 Auto
// Scaling group's `NotificationConfigurations`. Unlike EventBridge Rule Targets (which
// Cloud Control re-applies fine), ASG notifications are managed by a DEDICATED sub-API
// (PutNotificationConfiguration / DeleteNotificationConfiguration) that is NOT a normal
// mutable property — so this is the strongest candidate for a type where a removed
// collection is DETECTED (#416) but the whole-property re-add via Cloud Control
// UpdateResource FAILS, needing an SDK_WRITERS entry. The fixture deploys an ASG with
// one SNS notification config, removes it out of band, and verify.sh asserts detect ->
// revert -> CLEAN. desiredCapacity 0 (no instances launch) so it is fast and cheap.
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
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAsgNotificationRevert");

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
  maxCapacity: 4,
  desiredCapacity: 0,
});

const topic = new Topic(stack, "Topic");

const cfnAsg = asg.node.defaultChild as CfnAutoScalingGroup;
cfnAsg.notificationConfigurations = [
  {
    topicArn: topic.topicArn,
    notificationTypes: [
      "autoscaling:EC2_INSTANCE_LAUNCH",
      "autoscaling:EC2_INSTANCE_TERMINATE",
    ],
  },
];

app.synth();

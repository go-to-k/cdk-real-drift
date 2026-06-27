// CDK app for the cdk-real-drift EC2 Auto Scaling notification/metrics SET FP test.
// An ASG's `NotificationConfigurations[].NotificationTypes` (the lifecycle events to
// publish to SNS) and `MetricsCollection[].Metrics` (the group metrics to enable) are
// both scalar SETs the CFn schema marks insertionOrder:false, nested under an array —
// the schema-driven scalar fold skips array-crossing (`*`) paths, so they rely on the
// per-type table. Neither was ever probed. Each is declared in DELIBERATELY non-sorted
// order; if EC2 Auto Scaling echoes either reordered, a positional compare false-flags
// the identical set as declared drift on a freshly recorded ASG. ASGs with SNS
// notifications + group metrics are a common production pattern. desiredCapacity 0 (no
// instances launch) so the test is fast and cheap. A clean record -> check MUST be CLEAN.
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
const stack = new Stack(app, "CdkRealDriftIntegAsgNotificationMetrics");

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

// Reach the L1 to set the two SET properties in an exact non-sorted order.
const cfnAsg = asg.node.defaultChild as CfnAutoScalingGroup;
cfnAsg.notificationConfigurations = [
  {
    topicArn: topic.topicArn,
    // Lifecycle-event SET declared non-alphabetically.
    notificationTypes: [
      "autoscaling:EC2_INSTANCE_TERMINATE",
      "autoscaling:EC2_INSTANCE_LAUNCH",
      "autoscaling:EC2_INSTANCE_LAUNCH_ERROR",
    ],
  },
];
cfnAsg.metricsCollection = [
  {
    granularity: "1Minute",
    // Group-metric SET declared non-alphabetically.
    metrics: [
      "GroupTotalInstances",
      "GroupDesiredCapacity",
      "GroupMaxSize",
      "GroupMinSize",
    ],
  },
];

app.synth();

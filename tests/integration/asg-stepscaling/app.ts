// CDK app for the cdk-real-drift EC2 Auto Scaling step-scaling false-positive
// test. An EC2 ASG with a StepScaling policy is a common production pattern. Its
// StepScalingPolicyConfiguration.StepAdjustments is an OBJECT array whose
// elements carry NO standard identity field (Key/Id/Name) — so the global
// identity-keyed sort does NOT cover it. EC2 Auto Scaling returns StepAdjustments
// in its own canonical order (by interval bound); here they are declared OUT of
// order (upper band first). If AWS reorders them and the path is not folded, a
// positional diff false-flags StepAdjustments on a freshly deployed + recorded
// stack. A clean record -> check MUST be CLEAN. The ASG keeps desiredCapacity 0
// (no instances launch) so the test is fast and cheap.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Vpc, InstanceType, InstanceClass, InstanceSize, MachineImage, SubnetType, LaunchTemplate } from "aws-cdk-lib/aws-ec2";
import { AutoScalingGroup, CfnScalingPolicy } from "aws-cdk-lib/aws-autoscaling";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAsgStepScaling");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

// LaunchConfigurations are blocked for new accounts; use a LaunchTemplate.
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

// L1 ScalingPolicy so we control the exact StepAdjustments array order (the L2
// scaleOnMetric sorts the steps, hiding any AWS-side reorder). Declared OUT of
// ascending-bound order on purpose (upper band first).
new CfnScalingPolicy(stack, "StepPolicy", {
  autoScalingGroupName: asg.autoScalingGroupName,
  policyType: "StepScaling",
  adjustmentType: "ChangeInCapacity",
  metricAggregationType: "Average",
  stepAdjustments: [
    { metricIntervalLowerBound: 50, scalingAdjustment: 3 },
    { metricIntervalLowerBound: 10, metricIntervalUpperBound: 50, scalingAdjustment: 1 },
    { metricIntervalUpperBound: 10, scalingAdjustment: -1 },
  ],
});

app.synth();

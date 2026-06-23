// cdk-real-drift AutoScalingGroup AvailabilityZones reorder test.
// An AvailabilityZones list is a SET of AZ NAMES (us-east-1a, ...) — order carries no
// meaning — but AWS returns them in account/assignment order, not declared order
// (the existing RDS/Neptune corpus shows live AZ lists like [us-east-1c, us-east-1a,
// us-east-1b]). cdkrd's id-array canonicalizer skips AZ names because ID_RE requires a
// hex suffix (us-east-1a has none), so a positional compare false-flags a declared AZ
// list. This declares the AZ list in NON-sorted order to reveal the reorder. No NAT,
// desiredCapacity 0 (no instances) keeps it fast. A freshly deployed + recorded ASG
// with NO out-of-band change MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  AutoScalingGroup,
  CfnAutoScalingGroup,
} from "aws-cdk-lib/aws-autoscaling";
import {
  AmazonLinuxImage,
  InstanceClass,
  InstanceSize,
  InstanceType,
  LaunchTemplate,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAsgAzReorder");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 3,
  natGateways: 0,
  subnetConfiguration: [{ name: "pub", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const asg = new AutoScalingGroup(stack, "Asg", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  // Use a LaunchTemplate (LaunchConfiguration is no longer available in new accounts).
  launchTemplate: new LaunchTemplate(stack, "Lt", {
    instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
    machineImage: new AmazonLinuxImage(),
  }),
  minCapacity: 0,
  maxCapacity: 1,
  desiredCapacity: 0,
});

// The L2 emits AvailabilityZones into the template (derived from the chosen subnets);
// AWS returns them in account/assignment order, which the existing RDS/Neptune corpus
// shows is NOT the declared order — so this naturally exercises the AZ-list reorder
// without an override (an explicit override can't match the agnostic Fn::GetAZs subnets).
void (asg.node.defaultChild as CfnAutoScalingGroup);

app.synth();

// CDK app for the cdk-real-drift ecs-capacityprovider-rich false-positive integration
// test. Exercises three types cdkrd has never read live:
//   - AWS::ECS::CapacityProvider — an ASG-backed capacity provider with a rich
//     ManagedScaling block (TargetCapacity/step sizes/InstanceWarmupPeriod). AWS
//     materializes defaults for the ManagedScaling knobs left undeclared, so this is
//     prime KNOWN_DEFAULTS territory.
//   - AWS::ECS::ClusterCapacityProviderAssociations — the CapacityProviders list mixes
//     FARGATE / FARGATE_SPOT / the custom provider: a set-like scalar array that AWS may
//     echo in its own order (reorder-FP probe), plus a DefaultCapacityProviderStrategy
//     object array with no Key/Id/Name identity field.
//   - AWS::AutoScaling::WarmPool — attached to the same ASG with explicit zeros so no
//     instance ever launches; AWS fills PoolState/ReuseOnScaleIn style defaults.
// The ASG is min/max/desired 0-0-... (min 0, max 1, desired defaults to min) so the
// stack never runs an instance — deploy/delete is fast and free.
import { App, Stack } from "aws-cdk-lib";
import {
  AutoScalingGroup,
  PoolState,
} from "aws-cdk-lib/aws-autoscaling";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  LaunchTemplate,
  SubnetType,
  UserData,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { AsgCapacityProvider, Cluster, EcsOptimizedImage } from "aws-cdk-lib/aws-ecs";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsCapacityProvider");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "p", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const cluster = new Cluster(stack, "Cluster", {
  vpc,
  enableFargateCapacityProviders: true, // FARGATE + FARGATE_SPOT join the associations set
});

const lt = new LaunchTemplate(stack, "Lt", {
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: EcsOptimizedImage.amazonLinux2023(),
  userData: UserData.forLinux(),
  requireImdsv2: true,
  // addAsgCapacityProvider wires ECS cluster config into the instance role's
  // userdata, so the launch template must define one.
  role: new Role(stack, "InstanceRole", {
    assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
  }),
});

const asg = new AutoScalingGroup(stack, "Asg", {
  vpc,
  launchTemplate: lt,
  minCapacity: 0,
  maxCapacity: 1,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
});

// Zero-sized warm pool: the resource exists (and AWS fills its defaults) but no
// instance is ever prepared.
asg.addWarmPool({
  minGroupSize: 0,
  maxGroupPreparedCapacity: 0,
  poolState: PoolState.STOPPED,
  reuseOnScaleIn: false,
});

const cp = new AsgCapacityProvider(stack, "Cp", {
  capacityProviderName: "cdkrd-hunt-cp",
  autoScalingGroup: asg,
  enableManagedScaling: true,
  // Termination protection must stay OFF so teardown never blocks on protected instances.
  enableManagedTerminationProtection: false,
  targetCapacityPercent: 80,
  minimumScalingStepSize: 1,
  maximumScalingStepSize: 5,
  instanceWarmupPeriod: 120,
});
cluster.addAsgCapacityProvider(cp);

app.synth();

// Sibling-attachment echo probe (the ClientVPN #1574 class): a parent deployed
// ALONE can hide first-run FPs that only materialize when an attachment-style
// sibling lands in-stack (the association echoes back onto the PARENT's live
// read). Four common parent+attachment pairs whose ATTACHED-shape parent has
// never been pre-record first-checked (existing fixtures record first, which
// folds any materialized echo into the baseline silently):
// - SecretsManager Secret + RotationSchedule (does RotationRules/RotationEnabled
//   materialize on the Secret read?)
// - EC2 VPCEndpointService + VPCEndpointServicePermissions (AllowedPrincipals?)
// - ECS Cluster + ClusterCapacityProviderAssociations (CapacityProviders echo —
//   classify has hasSiblingCapacityProviders, this proves it live)
// - EFS FileSystem + MountTarget
import { App, Duration, Fn, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  CfnSecurityGroup,
  CfnSubnet,
  CfnVPC,
  CfnVPCEndpointService,
  CfnVPCEndpointServicePermissions,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnCluster,
  CfnClusterCapacityProviderAssociations,
} from "aws-cdk-lib/aws-ecs";
import { CfnFileSystem, CfnMountTarget } from "aws-cdk-lib/aws-efs";
import {
  CfnListener,
  CfnLoadBalancer,
  CfnTargetGroup,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { CfnRotationSchedule, CfnSecret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714AttachEcho");

// --- Secret + RotationSchedule (rotation NEVER runs: no rotate-immediately,
// far-future schedule; the dummy function is never invoked) ---
const secret = new CfnSecret(stack, "AttachSecret", {
  generateSecretString: {},
});
const rotFn = new LambdaFunction(stack, "AttachRotFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => {};"),
  timeout: Duration.seconds(30),
});
rotFn.addPermission("SecretsManagerInvoke", {
  principal: new ServicePrincipal("secretsmanager.amazonaws.com"),
});
const rotation = new CfnRotationSchedule(stack, "AttachRotation", {
  secretId: secret.ref,
  rotationLambdaArn: rotFn.functionArn,
  rotationRules: { scheduleExpression: "rate(365 days)" },
  rotateImmediatelyOnUpdate: false,
});
// Secrets Manager validates the function policy at create — wait for the permission.
rotation.node.addDependency(rotFn.permissionsNode.findChild("SecretsManagerInvoke"));

// --- minimal VPC (internal NLB for the endpoint service + EFS mount target) ---
const vpc = new CfnVPC(stack, "AttachVpc", { cidrBlock: "10.1.0.0/16" });
const subnet1 = new CfnSubnet(stack, "AttachSubnet1", {
  vpcId: vpc.ref,
  cidrBlock: "10.1.0.0/24",
  availabilityZone: Fn.select(0, Fn.getAzs()),
});

// --- VPCEndpointService + Permissions ---
const nlb = new CfnLoadBalancer(stack, "AttachNlb", {
  scheme: "internal",
  type: "network",
  subnets: [subnet1.ref],
});
const tg = new CfnTargetGroup(stack, "AttachTg", {
  protocol: "TCP",
  port: 80,
  targetType: "ip",
  vpcId: vpc.ref,
});
new CfnListener(stack, "AttachNlbListener", {
  loadBalancerArn: nlb.ref,
  port: 80,
  protocol: "TCP",
  defaultActions: [{ type: "forward", targetGroupArn: tg.ref }],
});
const epSvc = new CfnVPCEndpointService(stack, "AttachEpService", {
  networkLoadBalancerArns: [nlb.ref],
  acceptanceRequired: true,
});
new CfnVPCEndpointServicePermissions(stack, "AttachEpPerms", {
  serviceId: epSvc.ref,
  allowedPrincipals: [`arn:aws:iam::${stack.account}:root`],
});

// --- ECS Cluster + ClusterCapacityProviderAssociations ---
const ecsCluster = new CfnCluster(stack, "AttachEcsCluster", {
  clusterName: "cdkrd-hunt0714-attach-ecs",
});
new CfnClusterCapacityProviderAssociations(stack, "AttachEcsCpa", {
  cluster: ecsCluster.ref,
  capacityProviders: ["FARGATE", "FARGATE_SPOT"],
  defaultCapacityProviderStrategy: [
    { capacityProvider: "FARGATE", weight: 1 },
  ],
});

// --- EFS FileSystem + MountTarget ---
const efsSg = new CfnSecurityGroup(stack, "AttachEfsSg", {
  groupDescription: "cdkrd hunt0714 attach efs",
  vpcId: vpc.ref,
});
const efs = new CfnFileSystem(stack, "AttachEfs", {});
efs.applyRemovalPolicy(RemovalPolicy.DESTROY);
new CfnMountTarget(stack, "AttachEfsMt", {
  fileSystemId: efs.ref,
  subnetId: subnet1.ref,
  securityGroups: [efsSg.attrGroupId],
});

app.synth();

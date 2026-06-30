// CDK app for the cdk-real-drift Lambda + EFS false-positive test. Mounting an
// EFS access point into a VPC-attached Lambda is a common pattern for functions
// that need shared/persistent storage, and it is the last rich Lambda config not
// yet exercised: it adds FileSystemConfigs (Arn + LocalMountPath) plus a VpcConfig
// (SubnetIds + SecurityGroupIds, both set-like arrays AWS may reorder on read).
// A freshly deployed + recorded function with NO out-of-band change MUST report
// CLEAN. The VPC uses isolated subnets with NO NAT gateway to keep the deploy
// cheap and fast.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { AccessPoint, FileSystem } from "aws-cdk-lib/aws-efs";
import {
  Code,
  FileSystem as LambdaFileSystem,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLambdaEfs");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

const efs = new FileSystem(stack, "Efs", {
  vpc,
  removalPolicy: RemovalPolicy.DESTROY,
});

const accessPoint = new AccessPoint(stack, "AccessPoint", {
  fileSystem: efs,
  path: "/export/lambda",
  createAcl: { ownerGid: "1001", ownerUid: "1001", permissions: "750" },
  posixUser: { gid: "1001", uid: "1001" },
});

new LambdaFunction(stack, "Handler", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline(
    "export const handler = async () => ({ ok: true });",
  ),
  memorySize: 256,
  timeout: Duration.seconds(15),
  description: "cdkrd lambda-efs test handler",
  environment: { MOUNT: "/mnt/efs" },
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  filesystem: LambdaFileSystem.fromEfsAccessPoint(accessPoint, "/mnt/efs"),
});

app.synth();

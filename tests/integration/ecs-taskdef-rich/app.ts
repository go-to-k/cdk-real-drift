// CDK app for the cdk-real-drift ECS Fargate TaskDefinition false-positive test.
// The -added ECS fixtures cover child enumeration, but the TaskDefinition body
// itself — the most FP-prone ECS surface — was untested. A task definition packs
// a ContainerDefinitions JSON array that ECS heavily default-fills server-side
// (cpu/memory shares, mountPoints/volumesFrom empty arrays, logConfiguration
// option keys), plus task-level Cpu/Memory/NetworkMode/RequiresCompatibilities.
// No VPC or running service is needed, so it deploys near-instantly. A freshly
// deployed + recorded task definition with NO out-of-band change MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { ContainerImage, FargateTaskDefinition, LogDrivers } from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsTaskDefRich");

const logGroup = new LogGroup(stack, "Logs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

const taskDef = new FargateTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-ecs-taskdef-rich",
  cpu: 256,
  memoryLimitMiB: 512,
});

taskDef.addContainer("app", {
  image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:latest"),
  memoryReservationMiB: 256,
  essential: true,
  environment: {
    STAGE: "test",
    FEATURE_FLAG: "on",
  },
  portMappings: [{ containerPort: 80 }],
  logging: LogDrivers.awsLogs({ streamPrefix: "app", logGroup }),
});

app.synth();

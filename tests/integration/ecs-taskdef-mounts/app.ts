// CDK app for the cdk-real-drift ECS TaskDefinition nested-set FP test, round 2.
// PR #318 proved ECS reorders a container's PortMappings (an object-array set
// nested INSIDE the ContainerDefinitions array). This probes the OTHER set-like
// object arrays at the same level whose element key is NOT in IDENTITY_FIELDS
// (Key/Id/AttributeName/IndexName/Name), so neither the tag-list nor id-array
// canonicalizer aligns them:
//   - MountPoints   (keyed by SourceVolume)
//   - SystemControls (keyed by Namespace)
//   - VolumesFrom   (keyed by SourceContainer)
// Each is declared in DELIBERATELY non-sorted order. If ECS echoes any of them
// reordered, a positional compare false-flags declared drift on a freshly
// deployed + recorded task definition. Metadata-only (no cluster/instance/VPC) —
// deploys near-instantly. A clean recorded task def MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsTaskDefMounts");

new CfnTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-ecs-taskdef-mounts",
  networkMode: "bridge",
  requiresCompatibilities: ["EC2"],
  cpu: "256",
  memory: "512",
  // Two task-level volumes, declared out of name order.
  volumes: [{ name: "cache" }, { name: "data" }],
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: true,
      memoryReservation: 256,
      // MountPoints (SourceVolume key) declared cache-before-data (non-sorted).
      mountPoints: [
        { sourceVolume: "cache", containerPath: "/cache", readOnly: false },
        { sourceVolume: "data", containerPath: "/data", readOnly: true },
      ],
      // SystemControls (Namespace key) declared in non-sorted namespace order.
      systemControls: [
        { namespace: "net.ipv4.tcp_keepalive_time", value: "600" },
        { namespace: "net.core.somaxconn", value: "1024" },
      ],
    },
    {
      name: "logger",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: false,
      memoryReservation: 64,
    },
    {
      name: "sidecar",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: false,
      memoryReservation: 64,
      // VolumesFrom (SourceContainer key) declared logger-before-app (non-sorted).
      volumesFrom: [
        { sourceContainer: "logger", readOnly: true },
        { sourceContainer: "app", readOnly: false },
      ],
    },
  ],
});

app.synth();

// CDK app for the cdk-real-drift ECS (EC2 launch type) TaskDefinition
// false-positive test — focused on DEEPLY NESTED set-like arrays the existing
// ecs-taskdef-rich (Fargate, single port, no linuxParameters) never exercised.
//
// The prime suspect is `ContainerDefinitions[].LinuxParameters.Capabilities.Add`
// / `.Drop`: a Linux capability list is an unordered SET (order carries no
// meaning), declared here in DELIBERATELY non-alphabetical order. If ECS echoes
// it sorted/reordered, a positional compare false-flags declared drift — and this
// path is THREE levels deep, so the top-level-only UNORDERED_ARRAY_PROPS fold can
// never reach it. Capabilities.add is fully supported only on the EC2 launch type
// (Fargate restricts it), so this is an EC2/bridge task definition. We also probe
// multi-port PortMappings (declared out of order), Ulimits (an object array), and
// dnsSearchDomains/dnsServers (nested scalar sets). It is metadata-only — no
// cluster, instance, or VPC — so it deploys near-instantly. A freshly deployed +
// recorded task definition with NO out-of-band change MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsTaskDefCaps");

new CfnTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-ecs-taskdef-caps",
  networkMode: "bridge",
  requiresCompatibilities: ["EC2"],
  cpu: "256",
  memory: "512",
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: true,
      memoryReservation: 256,
      // Multiple port mappings declared OUT of numeric order — a set ECS may
      // echo reordered.
      portMappings: [
        { containerPort: 8080, hostPort: 8080, protocol: "tcp" },
        { containerPort: 443, hostPort: 443, protocol: "tcp" },
        { containerPort: 80, hostPort: 80, protocol: "tcp" },
      ],
      // THE prime FP probe: a Linux capability set declared non-alphabetically.
      linuxParameters: {
        capabilities: {
          add: ["SYS_PTRACE", "NET_ADMIN", "SYS_ADMIN"],
          drop: ["MKNOD", "AUDIT_WRITE"],
        },
      },
      // An object array (keyed by Name) plus nested scalar sets.
      ulimits: [
        { name: "nofile", softLimit: 1024, hardLimit: 4096 },
        { name: "nproc", softLimit: 512, hardLimit: 1024 },
      ],
      dnsServers: ["10.0.0.2", "10.0.0.3"],
      dnsSearchDomains: ["beta.example.com", "alpha.example.com"],
    },
    {
      name: "sidecar",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: false,
      memoryReservation: 128,
      portMappings: [{ containerPort: 9090, hostPort: 9090, protocol: "tcp" }],
    },
  ],
});

app.synth();

// CDK app for the cdk-real-drift ECS (EC2 launch type) TaskDefinition
// false-positive test — focused on the insertionOrder:false container sub-arrays
// the existing ecs-taskdef-{rich,caps,mounts} fixtures never exercised. The CFn
// schema marks all of these `insertionOrder: false` (AWS declares them unordered
// sets), but that flag is UNRELIABLE — most such sets are actually echoed in
// template order (caps/ulimits/dnsSearch/systemControls were all proven
// order-PRESERVING on prior deploys). Only an empirical deploy tells which ones
// AWS genuinely reorders. Each set below is declared in DELIBERATELY non-sorted
// order; if ECS echoes any of them reordered, a positional compare false-flags
// declared drift, and the path is nested under the ContainerDefinitions array so
// the top-level UNORDERED_* folds can never reach it.
//
// Probed (all previously UNTESTED — empty in every corpus case):
//   ContainerDefinitions[].DependsOn          (object set, keyed by ContainerName ∉ IDENTITY_FIELDS)
//   ContainerDefinitions[].Links              (scalar set)
//   ContainerDefinitions[].ExtraHosts         (object set: Hostname/IpAddress)
//   ContainerDefinitions[].DockerSecurityOptions (scalar set)
//   ContainerDefinitions[].DnsServers         (scalar set — declared non-sorted this time)
//   PlacementConstraints                      (object set: Type/Expression)
//
// Metadata-only (no cluster/instance/VPC) so it deploys near-instantly. A freshly
// deployed + recorded task definition with NO out-of-band change MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsTaskDefSets");

new CfnTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-ecs-taskdef-sets",
  networkMode: "bridge",
  requiresCompatibilities: ["EC2"],
  cpu: "256",
  memory: "512",
  // A task-level placement-constraint SET declared non-sorted (instance-type
  // expression after os-type; alphabetically the reverse).
  placementConstraints: [
    { type: "memberOf", expression: "attribute:ecs.os-type == linux" },
    { type: "memberOf", expression: "attribute:ecs.instance-type =~ t3.*" },
  ],
  containerDefinitions: [
    {
      name: "init",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: false,
      memoryReservation: 64,
    },
    {
      name: "logger",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: false,
      memoryReservation: 64,
    },
    {
      name: "app",
      image: "public.ecr.aws/nginx/nginx:latest",
      essential: true,
      memoryReservation: 256,
      // Container-startup ordering SET declared non-alphabetically by
      // ContainerName (logger before init). ContainerName is NOT an
      // IDENTITY_FIELD, so a keyed canonicalizer cannot align a reorder.
      dependsOn: [
        { containerName: "logger", condition: "START" },
        { containerName: "init", condition: "START" },
      ],
      // Legacy bridge-mode container LINKS — a scalar set declared non-sorted.
      links: ["logger:log", "init:setup"],
      // /etc/hosts entries — an object set declared non-sorted by Hostname.
      extraHosts: [
        { hostname: "zeta.internal", ipAddress: "10.0.0.9" },
        { hostname: "alpha.internal", ipAddress: "10.0.0.8" },
      ],
      // Docker security options — a scalar set declared non-sorted.
      dockerSecurityOptions: ["label:user:nginx", "label:role:webapp"],
      // DNS server set declared NON-sorted (the existing corpus only tested a
      // pre-sorted [10.0.0.2, 10.0.0.3] list — inconclusive for reorder).
      dnsServers: ["10.0.0.3", "10.0.0.2"],
    },
  ],
});

app.synth();

// CDK app for the cdk-real-drift ECS container Environment-order false-positive integ
// test. A Fargate task definition's container `Environment` is an object array of
// {Name,Value} pairs — keyed by `Name`, which IS an IDENTITY_FIELD, so cdkrd's
// canonicalizeTagLists should sort both sides by Name before comparing. But NO corpus
// case has a container with >=2 environment variables, so this Name-keyed reorder fold
// has never actually been exercised against a live read. Environment variables are an
// everyday container config. This fixture declares SIX env vars in deliberately
// NON-alphabetical order (ZEBRA, ALPHA, MIKE, ...) so that if AWS returns them in a
// different order — or if the Name-keyed sort regressed — a positional diff would
// surface a false declared drift. No cluster/service/VPC is needed: a standalone task
// definition registers instantly and reads cleanly via Cloud Control.
import { App, Stack } from "aws-cdk-lib";
import {
  Compatibility,
  ContainerDefinition,
  ContainerImage,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcsEnvOrder");

const taskDef = new TaskDefinition(stack, "TaskDef", {
  compatibility: Compatibility.FARGATE,
  cpu: "256",
  memoryMiB: "512",
});

new ContainerDefinition(stack, "Container", {
  taskDefinition: taskDef,
  image: ContainerImage.fromRegistry("public.ecr.aws/docker/library/busybox:latest"),
  // Deliberately NON-alphabetical declaration order — the reorder probe.
  environment: {
    ZEBRA: "z",
    ALPHA: "a",
    MIKE: "m",
    BRAVO: "b",
    YANKEE: "y",
    CHARLIE: "c",
  },
});

app.synth();

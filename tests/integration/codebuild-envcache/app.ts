// CDK app for the cdk-real-drift codebuild-envcache false-positive + coverage integration
// test. AWS::CodeBuild::Project is Cloud-Control NON_PROVISIONABLE, so cdkrd reads it via
// the BatchGetProjects SDK override. This fixture probes areas that reader had NOT exercised:
//   - Environment.EnvironmentVariables with MULTIPLE entries declared in a deliberately
//     NON-alphabetical order (ZED, ALPHA, MID) — the reader maps them in SDK order; if the
//     SDK returns them reordered, the declared compare would flag a false `declared` drift
//     (an env-var-list reorder FP, the CodeBuild analogue of the pipeline trigger-filter set).
//   - Cache LOCAL with multiple Modes (a set-like array) declared non-sorted.
// An S3 source keeps it connection-free (no GitHub webhook). A clean `record`->`check` is
// the FP oracle for the env-var and cache-mode nested shapes.
import { App, Stack } from "aws-cdk-lib";
import {
  Artifacts,
  BuildSpec,
  Cache,
  BuildEnvironmentVariableType,
  LocalCacheMode,
  Project,
  Source,
} from "aws-cdk-lib/aws-codebuild";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodeBuildEnvCache");
const bucket = new Bucket(stack, "Bucket");

new Project(stack, "Proj", {
  projectName: "cdkrd-envcache-build",
  source: Source.s3({ bucket, path: "source.zip" }),
  artifacts: Artifacts.s3({ bucket, name: "out", includeBuildId: false, packageZip: false }),
  buildSpec: BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo hi"] } },
  }),
  // Multiple env vars in a deliberately non-alphabetical declared order.
  environmentVariables: {
    ZED: { value: "z-value", type: BuildEnvironmentVariableType.PLAINTEXT },
    ALPHA: { value: "a-value", type: BuildEnvironmentVariableType.PLAINTEXT },
    MID: { value: "m-value", type: BuildEnvironmentVariableType.PLAINTEXT },
  },
  // LOCAL cache with multiple modes (a set-like array), declared non-sorted.
  cache: Cache.local(
    LocalCacheMode.SOURCE,
    LocalCacheMode.DOCKER_LAYER,
    LocalCacheMode.CUSTOM,
  ),
});

app.synth();

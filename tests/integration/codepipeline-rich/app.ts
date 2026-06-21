// CDK app for the cdk-real-drift codepipeline-rich false-positive integration test.
// A CodePipeline is a property-RICH CI/CD resource a large fraction of CDK users
// deploy: a V2 pipeline with an S3 artifact store, an S3 source stage and a CodeBuild
// build stage, each contributing nested config (ArtifactStore, Stages[].Actions[]
// with ActionTypeId / Configuration maps) that AWS folds into its own model with
// defaults (RunOrder, Region, Namespace, ExecutionMode). A clean `record`->`check`
// is a strong false-positive oracle for those nested CodePipeline structures. The
// artifact bucket uses autoDeleteObjects so teardown leaves no orphan (its custom
// resource Lambda log group carries the stack token and is swept).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { BuildSpec, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import { Artifact, Pipeline, PipelineType } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  S3SourceAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodepipelineRich");

const bucket = new Bucket(stack, "Artifacts", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const project = new PipelineProject(stack, "Build", {
  projectName: "cdkrd-pipeline-build",
  buildSpec: BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo hello"] } },
  }),
});

const sourceOutput = new Artifact();

new Pipeline(stack, "Pipeline", {
  pipelineName: "cdkrd-pipeline-rich",
  artifactBucket: bucket,
  pipelineType: PipelineType.V2,
  restartExecutionOnUpdate: false,
  stages: [
    {
      stageName: "Source",
      actions: [
        new S3SourceAction({
          actionName: "S3Source",
          bucket,
          bucketKey: "source.zip",
          output: sourceOutput,
        }),
      ],
    },
    {
      stageName: "Build",
      actions: [
        new CodeBuildAction({
          actionName: "Build",
          project,
          input: sourceOutput,
        }),
      ],
    },
  ],
});

app.synth();

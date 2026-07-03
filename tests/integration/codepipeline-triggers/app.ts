// CDK app for the cdk-real-drift codepipeline-triggers false-positive integration test.
// A V2 CodePipeline whose source is a CodeStar (CodeConnections) GitHub action driving
// a `Triggers` GitConfiguration block: push filters with Branches Includes/Excludes and
// FilePaths Includes/Excludes globs. Those filter lists are declared in the CFn schema as
// `uniqueItems: true` arrays WITHOUT `insertionOrder: false`, so cdkrd's schema-driven
// unordered fold does NOT cover them — if AWS re-orders a set-like filter list on read,
// the declared compare would flag a false `declared` drift. This is exactly the "branch
// trigger filter" reorder-FP class this fixture probes. Declared here in a deliberately
// NON-sorted order (release/* , main, develop / src, package.json, lib) so any AWS-side
// reordering surfaces as a mismatch. A clean `record`->`check` is the FP oracle.
//
// The connection ARN is passed via -c connectionArn=... (a PENDING connection is fine:
// the pipeline creates and stores its trigger config without the connection being
// authorized — we never actually run the pipeline).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { BuildSpec, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import {
  Artifact,
  Pipeline,
  PipelineType,
  ProviderType,
} from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  CodeStarConnectionsSourceAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodepipelineTriggers");

const connectionArn =
  (stack.node.tryGetContext("connectionArn") as string | undefined) ??
  "arn:aws:codeconnections:us-east-1:000000000000:connection/00000000-0000-0000-0000-000000000000";

const bucket = new Bucket(stack, "Artifacts", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const project = new PipelineProject(stack, "Build", {
  projectName: "cdkrd-triggers-build",
  buildSpec: BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo hello"] } },
  }),
});

const sourceOutput = new Artifact();
const sourceAction = new CodeStarConnectionsSourceAction({
  actionName: "GitHubSource",
  owner: "cdkrd-hunt-owner",
  repo: "cdkrd-hunt-repo",
  branch: "main",
  connectionArn,
  output: sourceOutput,
  // V2 pipeline: let the Triggers block drive starts, not the action's own push flag.
  triggerOnPush: false,
});

new Pipeline(stack, "Pipeline", {
  pipelineName: "cdkrd-triggers-pipeline",
  artifactBucket: bucket,
  pipelineType: PipelineType.V2,
  stages: [
    {
      stageName: "Source",
      actions: [sourceAction],
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
  triggers: [
    {
      providerType: ProviderType.CODE_STAR_SOURCE_CONNECTION,
      gitConfiguration: {
        sourceAction,
        pushFilter: [
          {
            // Deliberately NON-sorted, multi-element set-like lists to expose any
            // AWS-side reordering as a declared mismatch.
            branchesIncludes: ["release/*", "main", "develop"],
            branchesExcludes: ["experimental/*", "hotfix/*"],
            filePathsIncludes: ["src/**", "package.json", "lib/**"],
            filePathsExcludes: ["docs/**", "README.md"],
          },
        ],
      },
    },
  ],
});

app.synth();

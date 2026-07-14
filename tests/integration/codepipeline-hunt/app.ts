// False-positive probe (real AWS): barest CodePipeline — only a rich fixture
// existed. Declares ONLY RoleArn + ArtifactStore + the minimum two stages
// (S3 source + manual approval, so no build infrastructure is needed).
// High-value undeclared surface: PipelineType (AWS's console default flipped
// V1 -> V2), ExecutionMode, RestartExecutionOnUpdate, per-action defaults
// (PollForSourceChanges echo in the S3 source Configuration map), Triggers.
// The pipeline auto-starts once on create and the source action fails
// harmlessly (no object at the key); nothing bills while idle.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnPipeline } from "aws-cdk-lib/aws-codepipeline";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnBucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Pipe");

const bucket = new CfnBucket(stack, "HuntArtifacts", {
  versioningConfiguration: { status: "Enabled" },
});

const role = new Role(stack, "HuntPipeRole", {
  assumedBy: new ServicePrincipal("codepipeline.amazonaws.com"),
});
role.addToPolicy(
  new PolicyStatement({
    actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketVersioning", "s3:PutObject"],
    resources: [bucket.attrArn, `${bucket.attrArn}/*`],
  }),
);

const pipeline = new CfnPipeline(stack, "HuntPipeline", {
  roleArn: role.roleArn,
  artifactStore: { type: "S3", location: bucket.ref },
  stages: [
    {
      name: "Source",
      actions: [
        {
          name: "Src",
          actionTypeId: { category: "Source", owner: "AWS", provider: "S3", version: "1" },
          configuration: { S3Bucket: bucket.ref, S3ObjectKey: "src.zip" },
          outputArtifacts: [{ name: "SrcOut" }],
        },
      ],
    },
    {
      name: "Approve",
      actions: [
        {
          name: "Gate",
          actionTypeId: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" },
        },
      ],
    },
  ],
});
pipeline.node.addDependency(role);

app.synth();

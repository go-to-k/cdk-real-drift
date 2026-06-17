// CDK app for the AWS::CodeBuild::Project projection false-negative test. An S3-sourced
// Project (so artifacts.encryptionDisabled is settable, unlike a CODEPIPELINE project)
// declaring concurrentBuildLimit and artifact encryption ON.
//
// The override reader projected a thin model that OMITTED ConcurrentBuildLimit AND the
// security flags Artifacts.EncryptionDisabled / Source.InsecureSsl / Source.ReportBuildStatus
// — so an out-of-band change to them was undetectable. verify-codebuild-proj.sh changes
// ConcurrentBuildLimit and turns OFF artifact encryption out of band and asserts both are
// now DETECTED, and (FP guard) that the freshly-deployed project still checks CLEAN after
// record (EncryptionDisabled=false folds via isTrivialEmpty; Visibility=PRIVATE folds to
// atDefault; InsecureSsl/ReportBuildStatus are absent for an S3 source).
import { App, Stack } from "aws-cdk-lib";
import { Artifacts, BuildSpec, Project, Source } from "aws-cdk-lib/aws-codebuild";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodeBuild");
const bucket = new Bucket(stack, "Bucket");
new Project(stack, "Proj", {
  source: Source.s3({ bucket, path: "source.zip" }),
  artifacts: Artifacts.s3({ bucket, name: "out", includeBuildId: false, packageZip: false }),
  buildSpec: BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo hi"] } },
  }),
  concurrentBuildLimit: 1,
});
app.synth();

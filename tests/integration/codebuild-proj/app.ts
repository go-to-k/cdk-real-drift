// Minimal CDK app for the AWS::CodeBuild::Project projection false-negative test. A
// PipelineProject (CODEPIPELINE source, no external repo) declaring a concurrentBuildLimit.
// The override reader used to project a thin model that OMITTED ConcurrentBuildLimit,
// VpcConfig, Visibility, SourceVersion — so an out-of-band change to them was
// undetectable. verify-codebuild-proj.sh changes ConcurrentBuildLimit out of band and
// asserts it is now DETECTED, and (FP guard) that the freshly-deployed project — whose
// live Visibility=PRIVATE is now read — still checks CLEAN (PRIVATE folds to atDefault).
import { App, Stack } from "aws-cdk-lib";
import { PipelineProject } from "aws-cdk-lib/aws-codebuild";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodeBuild");
new PipelineProject(stack, "Proj", { concurrentBuildLimit: 1 });
app.synth();

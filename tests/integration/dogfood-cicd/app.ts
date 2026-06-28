// CDK app for the cdk-real-drift DOGFOOD (CI/CD domain): a CodePipeline with an S3
// source, a CodeBuild build stage, and an S3 deploy stage, plus the IAM roles wiring
// them. Exercises the INTERACTION of CodePipeline (its Stages/Actions), CodeBuild, S3
// and IAM. A clean `record` -> `check` MUST be CLEAN; any declared drift is an FP.
import { App, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { BuildSpec, LinuxBuildImage, PipelineProject } from 'aws-cdk-lib/aws-codebuild';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import {
  CodeBuildAction,
  S3DeployAction,
  S3SourceAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

class DogfoodCicdStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const sourceBucket = new Bucket(this, 'Source', {
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const deployBucket = new Bucket(this, 'Deploy', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const project = new PipelineProject(this, 'Build', {
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo build'] } },
        artifacts: { files: ['**/*'] },
      }),
    });

    const sourceOut = new Artifact('Source');
    const buildOut = new Artifact('Build');
    new Pipeline(this, 'Pipeline', {
      stages: [
        {
          stageName: 'Source',
          actions: [
            new S3SourceAction({
              actionName: 'S3Source',
              bucket: sourceBucket,
              bucketKey: 'source.zip',
              output: sourceOut,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new CodeBuildAction({
              actionName: 'Build',
              project,
              input: sourceOut,
              outputs: [buildOut],
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new S3DeployAction({ actionName: 'Deploy', bucket: deployBucket, input: buildOut }),
          ],
        },
      ],
    });
  }
}

const app = new App();
new DogfoodCicdStack(app, 'CdkRealDriftIntegDogfoodCicd', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

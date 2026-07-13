// Barest-config SageMaker MonitoringSchedule fixture for the cdk-real-drift FP hunt.
// AWS::SageMaker::MonitoringSchedule is read via readSageMakerMonitoringSchedule
// (the #1523 ARN-vs-name fix) but had ZERO corpus cases and ZERO fixtures — the
// reader was never exercised live, and it projects the SDK-shaped
// MonitoringScheduleConfig WHOLESALE, a prime echo-FP surface. Uses a
// BatchTransformInput (NOT EndpointInput) so no SageMaker endpoint is needed —
// the schedule deploys against a plain S3 prefix. The cron fires daily at 23:00
// UTC so no processing job ever launches inside a hunt window (near-zero cost).
// First check (before record) MUST be CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnMonitoringSchedule } from "aws-cdk-lib/aws-sagemaker";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntSmMonSched0713");

const bucket = new Bucket(stack, "Data", { removalPolicy: RemovalPolicy.DESTROY });
const role = new Role(stack, "MonitorRole", {
  assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
});
role.addToPolicy(
  new PolicyStatement({
    actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
    resources: [bucket.bucketArn, bucket.arnForObjects("*")],
  })
);

// us-east-1 account for the AWS-provided model-monitor analyzer image.
const analyzerImage =
  "156813124566.dkr.ecr.us-east-1.amazonaws.com/sagemaker-model-monitor-analyzer";

new CfnMonitoringSchedule(stack, "Schedule", {
  monitoringScheduleName: "cdkrd-hunt-monsched-0713",
  monitoringScheduleConfig: {
    scheduleConfig: { scheduleExpression: "cron(0 23 ? * * *)" },
    monitoringJobDefinition: {
      monitoringInputs: [
        {
          batchTransformInput: {
            dataCapturedDestinationS3Uri: `s3://${bucket.bucketName}/capture`,
            datasetFormat: { csv: { header: false } },
            localPath: "/opt/ml/processing/input",
          },
        },
      ],
      monitoringOutputConfig: {
        monitoringOutputs: [
          {
            s3Output: {
              s3Uri: `s3://${bucket.bucketName}/out`,
              localPath: "/opt/ml/processing/output",
            },
          },
        ],
      },
      monitoringResources: {
        clusterConfig: { instanceCount: 1, instanceType: "ml.m5.large", volumeSizeInGb: 20 },
      },
      monitoringAppSpecification: { imageUri: analyzerImage },
      roleArn: role.roleArn,
    },
  },
});

app.synth();

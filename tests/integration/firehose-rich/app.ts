// CDK app for the cdk-real-drift Kinesis Data Firehose false-positive test. A
// DirectPut delivery stream to S3 (ExtendedS3DestinationConfiguration) is the
// common log/event-to-S3 pipeline. It exercises a deeply nested destination
// config — BufferingHints, CompressionFormat, prefixes, CloudWatchLoggingOptions,
// EncryptionConfiguration — that Firehose default-fills + re-serializes server
// side. A freshly deployed + recorded stream with NO out-of-band change MUST be
// CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { LogGroup, LogStream, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegFirehoseRich");

const bucket = new Bucket(stack, "Dest", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const role = new Role(stack, "Role", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
});
bucket.grantReadWrite(role);

const logGroup = new LogGroup(stack, "Logs", {
  logGroupName: "/cdkrd/firehose-rich",
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});
const logStream = new LogStream(stack, "LogStream", {
  logGroup,
  logStreamName: "S3Delivery",
  removalPolicy: RemovalPolicy.DESTROY,
});

new CfnDeliveryStream(stack, "Stream", {
  deliveryStreamName: "cdkrd-firehose-rich",
  deliveryStreamType: "DirectPut",
  extendedS3DestinationConfiguration: {
    bucketArn: bucket.bucketArn,
    roleArn: role.roleArn,
    bufferingHints: { intervalInSeconds: 300, sizeInMBs: 5 },
    compressionFormat: "GZIP",
    prefix: "data/",
    errorOutputPrefix: "errors/",
    cloudWatchLoggingOptions: {
      enabled: true,
      logGroupName: logGroup.logGroupName,
      logStreamName: logStream.logStreamName,
    },
    encryptionConfiguration: { noEncryptionConfig: "NoEncryption" },
  },
});

app.synth();

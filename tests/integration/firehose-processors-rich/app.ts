// CDK app for the cdk-real-drift Kinesis Data Firehose Processors-reorder
// false-positive test. A DirectPut delivery stream to S3 with a
// ProcessingConfiguration whose single Lambda Processor carries a Parameters
// array ({ParameterName, ParameterValue}). ParameterName is NOT in cdkrd's
// IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), and the array is nested
// under ProcessingConfiguration.Processors, so if Firehose returns Parameters in
// its own canonical order a positional diff would false-flag declared drift —
// the nested-object-array-set reorder class. The Parameters are declared in
// DELIBERATELY NON-canonical order (LambdaArn last) so a reorder, if Firehose
// performs one, is revealed: a freshly deployed + recorded stream MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { Code, Function as LambdaFn, Runtime } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegFirehoseProcessorsRich");

const bucket = new Bucket(stack, "Dest", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const role = new Role(stack, "Role", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
});
bucket.grantReadWrite(role);

// A transform Lambda for the Firehose processor. It never actually runs in this
// test (no data is put), it only needs to EXIST so the stream's
// ProcessingConfiguration references a real function ARN.
const transform = new LambdaFn(stack, "Transform", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline(
    "exports.handler = async (e) => ({ records: (e.records || []).map((r) => ({ recordId: r.recordId, result: 'Ok', data: r.data })) });"
  ),
});
transform.grantInvoke(role);

new CfnDeliveryStream(stack, "Stream", {
  deliveryStreamName: "cdkrd-firehose-processors-rich",
  deliveryStreamType: "DirectPut",
  extendedS3DestinationConfiguration: {
    bucketArn: bucket.bucketArn,
    roleArn: role.roleArn,
    bufferingHints: { intervalInSeconds: 300, sizeInMBs: 5 },
    compressionFormat: "GZIP",
    prefix: "data/",
    errorOutputPrefix: "errors/",
    processingConfiguration: {
      enabled: true,
      processors: [
        {
          type: "Lambda",
          // Declared NON-canonical (LambdaArn last, then the numeric tuning
          // params): if Firehose canonicalizes the Parameters set into a
          // different order, a positional compare surfaces it.
          parameters: [
            { parameterName: "RoleArn", parameterValue: role.roleArn },
            { parameterName: "BufferSizeInMBs", parameterValue: "1" },
            { parameterName: "BufferIntervalInSeconds", parameterValue: "61" },
            { parameterName: "LambdaArn", parameterValue: transform.functionArn },
          ],
        },
      ],
    },
  },
});

app.synth();

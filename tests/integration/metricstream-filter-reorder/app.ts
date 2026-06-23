// cdk-real-drift CloudWatch MetricStream IncludeFilters reorder test.
// A MetricStream's `IncludeFilters` is an ARRAY of {Namespace, MetricNames} keyed by
// Namespace (NOT one of cdkrd's IDENTITY_FIELDS), so a positional compare false-flags
// every shifted filter if CloudWatch returns them in a different order than declared.
// The filters are declared in NON-alphabetical Namespace order to reveal any
// sort-on-read. A freshly deployed + recorded stream with NO out-of-band change MUST
// be CLEAN (either CloudWatch preserves the order, or the per-type fold aligns the
// set). Needs a Firehose delivery stream + two IAM roles (MetricStream -> Firehose,
// Firehose -> S3).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnMetricStream } from "aws-cdk-lib/aws-cloudwatch";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMetricStreamFilterReorder");

const bucket = new Bucket(stack, "Bucket", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const firehoseRole = new Role(stack, "FirehoseRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
});
bucket.grantReadWrite(firehoseRole);

const stream = new CfnDeliveryStream(stack, "Delivery", {
  deliveryStreamType: "DirectPut",
  s3DestinationConfiguration: {
    bucketArn: bucket.bucketArn,
    roleArn: firehoseRole.roleArn,
  },
});

const metricStreamRole = new Role(stack, "MetricStreamRole", {
  assumedBy: new ServicePrincipal("streams.metrics.cloudwatch.amazonaws.com"),
});
metricStreamRole.addToPolicy(
  new PolicyStatement({
    actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
    resources: [stream.attrArn],
  })
);

new CfnMetricStream(stack, "Stream", {
  firehoseArn: stream.attrArn,
  roleArn: metricStreamRole.roleArn,
  outputFormat: "json",
  // Deliberately NON-alphabetical Namespace order so a sort-on-read is revealed.
  includeFilters: [
    { namespace: "AWS/S3" },
    { namespace: "AWS/EC2" },
    { namespace: "AWS/Lambda" },
  ],
});

app.synth();

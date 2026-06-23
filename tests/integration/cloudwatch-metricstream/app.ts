// CloudWatch MetricStream (to a Firehose -> S3 sink) with multiple IncludeFilters —
// an object array (keyed by Namespace) AWS may return reordered, a reorder-FP
// candidate. MetricStream is a common observability export; clean record->check is the
// FP oracle. Firehose + S3 + roles are cheap (no NAT, no stateful provisioning).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { CfnMetricStream } from "aws-cdk-lib/aws-cloudwatch";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCloudwatchMetricstream");

const sink = new Bucket(stack, "Sink", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const fhRole = new Role(stack, "FhRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
});
sink.grantReadWrite(fhRole);

const fh = new CfnDeliveryStream(stack, "Fh", {
  deliveryStreamType: "DirectPut",
  s3DestinationConfiguration: {
    bucketArn: sink.bucketArn,
    roleArn: fhRole.roleArn,
  },
});

const msRole = new Role(stack, "MsRole", {
  assumedBy: new ServicePrincipal("streams.metrics.cloudwatch.amazonaws.com"),
});
msRole.addToPolicy(
  new PolicyStatement({
    actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
    resources: [fh.attrArn],
  }),
);

new CfnMetricStream(stack, "Stream", {
  firehoseArn: fh.attrArn,
  roleArn: msRole.roleArn,
  outputFormat: "json",
  includeFilters: [
    { namespace: "AWS/EC2", metricNames: ["CPUUtilization", "NetworkIn"] },
    { namespace: "AWS/Lambda", metricNames: [] },
    { namespace: "AWS/S3" },
  ],
});

app.synth();

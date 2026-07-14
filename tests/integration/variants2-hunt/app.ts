// False-positive probe (real AWS): three common VARIANT axes with zero fixture
// coverage in their barest form — a default is frequently a function of the
// variant, so a variant never deployed is an unguarded fold gap (#1477 class):
// - AWS::EFS::FileSystem One Zone (AvailabilityZoneName) — every existing EFS
//   fixture is Regional; One Zone materializes AvailabilityZoneId and may
//   default differently.
// - AWS::SageMaker::EndpointConfig SERVERLESS variant (ServerlessConfig, no
//   instanceType/count) — sagemaker-epc-min covers only the instance variant.
// - AWS::KinesisFirehose::DeliveryStream HttpEndpointDestinationConfiguration
//   (Datadog/Splunk-style) — every existing Firehose fixture is ExtendedS3.
// Nothing here bills while idle (EPC/Model are metadata; Firehose DirectPut
// with no producers; empty EFS). Pinned to us-east-1 (DLC image + AZ name).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnFileSystem } from "aws-cdk-lib/aws-efs";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnEndpointConfig, CfnModel } from "aws-cdk-lib/aws-sagemaker";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Var2");

// --- EFS One Zone, barest (no VPC needed; mount targets are what need one) ---
new CfnFileSystem(stack, "HuntOneZoneFs", {
  availabilityZoneName: "us-east-1a",
});

// --- SageMaker serverless EndpointConfig, barest serverless variant ---
const smRole = new Role(stack, "HuntSmRole", {
  assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
});
const model = new CfnModel(stack, "HuntSmModel", {
  executionRoleArn: smRole.roleArn,
  primaryContainer: {
    image: "683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3",
  },
});
new CfnEndpointConfig(stack, "HuntServerlessEpc", {
  productionVariants: [
    {
      modelName: model.attrModelName,
      variantName: "AllTraffic",
      serverlessConfig: {
        maxConcurrency: 5,
        memorySizeInMb: 2048,
      },
    },
  ],
});

// --- Firehose HTTP-endpoint destination, barest (S3 backup config is required) ---
// No autoDeleteObjects: DirectPut with no producers never writes a byte, and
// skipping it avoids the custom-resource Lambda + its orphan log group.
const backupBucket = new Bucket(stack, "HuntFirehoseBackup", {
  removalPolicy: RemovalPolicy.DESTROY,
});
const fhRole = new Role(stack, "HuntFirehoseRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
});
fhRole.addToPolicy(
  new PolicyStatement({
    actions: ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"],
    resources: [backupBucket.bucketArn, `${backupBucket.bucketArn}/*`],
  }),
);
new CfnDeliveryStream(stack, "HuntHttpFirehose", {
  httpEndpointDestinationConfiguration: {
    endpointConfiguration: {
      // Firehose validates the URL shape at create (https, port 443/unspecified,
      // real-looking domain — a `.invalid` TLD is REJECTED with "Invalid Url").
      // example.com is reserved + resolvable; nothing is ever delivered (DirectPut,
      // no producers), so no traffic reaches it.
      url: "https://example.com/cdkrd-hunt",
      name: "hunt-endpoint",
    },
    s3Configuration: {
      bucketArn: backupBucket.bucketArn,
      roleArn: fhRole.roleArn,
    },
  },
});

app.synth();

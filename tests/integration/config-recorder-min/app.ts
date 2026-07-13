// CDK app for the cdk-real-drift AWS Config recorder coverage test (#1553).
//
// Unlike the config-rule-rich fixture — which provisions the recorder + delivery
// channel via the SDK so the ConfigRule has an active recorder without CloudFormation
// ever owning the recorder — this fixture makes the recorder AND delivery channel
// CFn-managed L1 resources, so cdkrd reads them as DECLARED resources via Cloud
// Control. That is the coverage gap #1553 tracks: AWS::Config::ConfigurationRecorder
// and AWS::Config::DeliveryChannel first-run FP behaviour, record->check cleanliness,
// and detection were all unverified.
//
// The recorder + delivery channel are account/region SINGLETONS: verify.sh MUST abort
// unless the target region has neither, so this fixture never fights a real recorder.
//
// The recorder's CFn handler is known to hang CREATE_IN_PROGRESS 20-45+ min in some
// account/region combos (see #1553); deploy in an alternate region (AWS_REGION) and
// cap the wait if it stalls.
import { App, type CfnResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CfnConfigurationRecorder,
  CfnDeliveryChannel,
} from "aws-cdk-lib/aws-config";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegConfigRecorder");

// Delivery bucket Config writes configuration snapshots to. The bucket policy grants
// the config.amazonaws.com service the documented permissions-check + delivery grants.
const bucket = new Bucket(stack, "DeliveryBucket", {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  encryption: BucketEncryption.S3_MANAGED,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

// The recorder's service-linked-style role. AWS_ConfigRole is the AWS-managed policy
// AWS Config expects for the recorder.
const role = new Role(stack, "RecorderRole", {
  assumedBy: new ServicePrincipal("config.amazonaws.com"),
  managedPolicies: [
    { managedPolicyArn: "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole" },
  ],
});

const account = Stack.of(stack).account;
bucket.addToResourcePolicy(
  new PolicyStatement({
    sid: "AWSConfigBucketPermissionsCheck",
    principals: [new ServicePrincipal("config.amazonaws.com")],
    actions: ["s3:GetBucketAcl", "s3:ListBucket"],
    resources: [bucket.bucketArn],
  }),
);
bucket.addToResourcePolicy(
  new PolicyStatement({
    sid: "AWSConfigBucketDelivery",
    principals: [new ServicePrincipal("config.amazonaws.com")],
    actions: ["s3:PutObject"],
    resources: [`${bucket.bucketArn}/AWSLogs/${account}/Config/*`],
    conditions: {
      StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" },
    },
  }),
);

// A minimal recording group: record only S3 buckets (not allSupported) to keep the
// blast radius tiny. This is a declared, mutable property cdkrd should be able to read
// and detect drift on.
const recorder = new CfnConfigurationRecorder(stack, "Recorder", {
  roleArn: role.roleArn,
  recordingGroup: {
    allSupported: false,
    includeGlobalResourceTypes: false,
    resourceTypes: ["AWS::S3::Bucket"],
  },
});

const channel = new CfnDeliveryChannel(stack, "Channel", {
  s3BucketName: bucket.bucketName,
});

// Ordering is the crux of the recorder's create-stabilization deadlock (#1553): the
// recorder resource does not report CREATE_COMPLETE until it can record, which needs a
// delivery channel — but a delivery channel's put requires the recorder to already
// exist. Chaining channel-after-recorder (or recorder-after-channel) deadlocks. The
// canonical AWS pattern instead creates BOTH concurrently, each depending only on the
// bucket policy, so the recorder's put and the channel's put interleave and the
// recorder can stabilize. So: NO recorder<->channel dependency; both wait on the
// bucket policy (the channel needs it to write; ordering the recorder behind it too
// keeps the two puts close together).
const bucketPolicy = bucket.policy;
if (bucketPolicy) {
  recorder.addDependency(bucketPolicy.node.defaultChild as CfnResource);
  channel.addDependency(bucketPolicy.node.defaultChild as CfnResource);
}

app.synth();

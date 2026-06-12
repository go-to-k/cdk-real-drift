// CDK app for the cdk-real-drift POLICIES integration test: one resource per
// SDK writer (see src/revert/writers.ts SDK_WRITERS) so verify.sh exercises
// every type-specific write path end-to-end:
//   AWS::S3::BucketPolicy / AWS::SNS::TopicPolicy / AWS::SQS::QueuePolicy /
//   AWS::IAM::Policy (standalone inline) / AWS::IAM::ManagedPolicy
// The bucket is never written to (no autoDeleteObjects needed — destroy works
// on an empty bucket, and a leaner policy makes the drift injection simpler).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AnyPrincipal,
  Effect,
  ManagedPolicy,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Topic, TopicPolicy } from "aws-cdk-lib/aws-sns";
import { Queue, QueuePolicy } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegPolicies");

// S3 bucket + resource policy (creates AWS::S3::BucketPolicy at Data/Policy)
const bucket = new Bucket(stack, "Data", { removalPolicy: RemovalPolicy.DESTROY });
bucket.addToResourcePolicy(
  new PolicyStatement({
    sid: "DenyInsecureTransport",
    effect: Effect.DENY,
    principals: [new AnyPrincipal()],
    actions: ["s3:*"],
    resources: [bucket.bucketArn, bucket.arnForObjects("*")],
    conditions: { Bool: { "aws:SecureTransport": "false" } },
  })
);

// SNS topic + topic policy
const topic = new Topic(stack, "Events");
new TopicPolicy(stack, "EventsPolicy", { topics: [topic] }).document.addStatements(
  new PolicyStatement({
    sid: "AllowS3Publish",
    principals: [new ServicePrincipal("s3.amazonaws.com")],
    actions: ["sns:Publish"],
    resources: [topic.topicArn],
  })
);

// SQS queue + queue policy
const queue = new Queue(stack, "Jobs");
new QueuePolicy(stack, "JobsPolicy", { queues: [queue] }).document.addStatements(
  new PolicyStatement({
    sid: "AllowSnsSend",
    principals: [new ServicePrincipal("sns.amazonaws.com")],
    actions: ["sqs:SendMessage"],
    resources: [queue.queueArn],
  })
);

// IAM role + standalone inline policy (AWS::IAM::Policy) + managed policy
const role = new Role(stack, "Worker", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
});
new Policy(stack, "WorkerInline", {
  roles: [role],
  statements: [
    new PolicyStatement({
      sid: "ReadData",
      actions: ["s3:GetObject"],
      resources: [bucket.arnForObjects("*")],
    }),
  ],
});
new ManagedPolicy(stack, "WorkerManaged", {
  roles: [role],
  statements: [
    new PolicyStatement({
      sid: "ListData",
      actions: ["s3:ListBucket"],
      resources: [bucket.bucketArn],
    }),
  ],
});

app.synth();

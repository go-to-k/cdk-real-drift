// Second-deploy echo probe, batch 2 (post-update echo materialization, the #1569
// class): the types the first batch did not cover — the API Gateway REST chain
// (RestApi/Resource/Method/Deployment/Stage), SSM Parameter, Secrets Manager
// Secret, CloudWatch Alarm, EventBridge EventBus, an SNS->SQS Subscription,
// Firehose DeliveryStream (S3 destination), Scheduler Schedule, IAM
// ManagedPolicy, and a Logs MetricFilter. Deploy barest, first check MUST be
// CLEAN, then a harmless `-c rev=2` tag/description update, then check MUST
// STILL be clean.
import { App, Aws, Stack, Tags } from "aws-cdk-lib";
import {
  CfnDeployment,
  CfnMethod,
  CfnResource,
  CfnRestApi,
  CfnStage,
} from "aws-cdk-lib/aws-apigateway";
import { CfnAlarm } from "aws-cdk-lib/aws-cloudwatch";
import { CfnEventBus } from "aws-cdk-lib/aws-events";
import { CfnManagedPolicy, CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { CfnLogGroup, CfnMetricFilter } from "aws-cdk-lib/aws-logs";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { CfnSecret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnSubscription, CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { CfnParameter } from "aws-cdk-lib/aws-ssm";

const app = new App();
const rev = String(app.node.tryGetContext("rev") ?? "1");
Tags.of(app).add("cdkrd:ephemeral", "1");

const stack = new Stack(app, "CdkrdHuntEcho2v0714");
Tags.of(stack).add("cdkrd:rev", rev);

new CfnParameter(stack, "Echo2Param0714", {
  type: "String",
  value: `probe-rev-${rev}`,
});

new CfnSecret(stack, "Echo2Secret0714", {
  description: `cdkrd echo probe rev ${rev}`,
});

new CfnAlarm(stack, "Echo2Alarm0714", {
  namespace: "AWS/SQS",
  metricName: "ApproximateNumberOfMessagesVisible",
  statistic: "Average",
  period: 300,
  evaluationPeriods: 1,
  threshold: 1000000,
  comparisonOperator: "GreaterThanThreshold",
  alarmDescription: `cdkrd echo probe rev ${rev}`,
});

new CfnEventBus(stack, "Echo2Bus0714", {
  name: "cdkrd-echo2-bus-0714",
  description: `cdkrd echo probe rev ${rev}`,
});

const topic = new CfnTopic(stack, "Echo2Topic0714", {});
const queue = new CfnQueue(stack, "Echo2Queue0714", {});
new CfnSubscription(stack, "Echo2Sub0714", {
  topicArn: topic.ref,
  protocol: "sqs",
  endpoint: queue.attrArn,
});

// API Gateway REST chain — every layer updated via the description/variables.
const api = new CfnRestApi(stack, "Echo2Api0714", {
  name: "cdkrd-echo2-api-0714",
  description: `cdkrd echo probe rev ${rev}`,
});
const res = new CfnResource(stack, "Echo2Res0714", {
  restApiId: api.ref,
  parentId: api.attrRootResourceId,
  pathPart: "probe",
});
const method = new CfnMethod(stack, "Echo2Method0714", {
  restApiId: api.ref,
  resourceId: res.ref,
  httpMethod: "GET",
  authorizationType: "NONE",
  integration: { type: "MOCK", requestTemplates: { "application/json": '{"statusCode": 200}' } },
});
const deployment = new CfnDeployment(stack, `Echo2Deploy0714R${rev}`, {
  restApiId: api.ref,
});
deployment.addDependency(method);
new CfnStage(stack, "Echo2Stage0714", {
  restApiId: api.ref,
  deploymentId: deployment.ref,
  stageName: "probe",
  variables: { rev },
});

const logGroup = new CfnLogGroup(stack, "Echo2Logs0714", {});
new CfnMetricFilter(stack, "Echo2Mf0714", {
  logGroupName: logGroup.ref,
  filterPattern: "ERROR",
  metricTransformations: [
    {
      metricName: `cdkrd-echo2-metric-rev${rev}`,
      metricNamespace: "CdkrdEcho2",
      metricValue: "1",
    },
  ],
});

new CfnManagedPolicy(stack, "Echo2Pol0714", {
  description: "cdkrd echo probe",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "s3:ListAllMyBuckets",
        Resource: "*",
        Sid: `Rev${rev}`,
      },
    ],
  },
});

const schedRole = new CfnRole(stack, "Echo2SchedRole0714", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "scheduler.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});
new CfnSchedule(stack, "Echo2Sched0714", {
  scheduleExpression: "rate(1 hour)",
  state: "DISABLED",
  description: `cdkrd echo probe rev ${rev}`,
  flexibleTimeWindow: { mode: "OFF" },
  target: {
    arn: queue.attrArn,
    roleArn: schedRole.attrArn,
  },
});

const fhBucket = new CfnBucket(stack, "Echo2FhBucket0714", {});
const fhRole = new CfnRole(stack, "Echo2FhRole0714", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "firehose.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  policies: [
    {
      policyName: "fh-s3",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket", "s3:AbortMultipartUpload"],
            Resource: [fhBucket.attrArn, `${fhBucket.attrArn}/*`],
          },
        ],
      },
    },
  ],
});
new CfnDeliveryStream(stack, "Echo2Fh0714", {
  deliveryStreamType: "DirectPut",
  s3DestinationConfiguration: {
    bucketArn: fhBucket.attrArn,
    roleArn: fhRole.attrArn,
  },
});

// Aws.ACCOUNT_ID keeps the template account-agnostic (also exercises the
// pseudo-parameter resolution path on the alarm's undeclared surface).
void Aws.ACCOUNT_ID;

app.synth();

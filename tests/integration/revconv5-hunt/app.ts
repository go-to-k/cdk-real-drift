// CDK app for the cdk-real-drift revconv5 hunt: revert-convergence batch 7 over
// KNOWN_DEFAULTS-folded MUTABLE props never probed for the silent-no-op revert class
// (see hunt-bugs SKILL.md "revert non-convergence" — ~1-in-3 needs an RSDP entry):
//   - Lambda::Function  RecursiveLoop ('Terminate') + RuntimeManagementConfig ({Auto})
//   - ApiGatewayV2::Api (HTTP) DisableExecuteApiEndpoint (false)
//   - SES::ConfigurationSet SendingOptions.SendingEnabled + ReputationOptions.
//     ReputationMetricsEnabled (both true — off-flip candidates)
//   - KinesisVideo::Stream DataRetentionInHours (0)
//   - CloudTrail::Trail EventSelectors (management/All default array)
// Plus two free ride-along probes:
//   - AAS ScalableTarget with TWO ScheduledActions declared in non-alphabetical order
//     (echo-reorder probe — the existing corpus/fixture only ever had one action)
//   - every resource in its BAREST form → the first (pre-record) check doubles as a
//     first-run FP probe, and a `-c rev=2` redeploy probes post-update echo.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnApi } from "aws-cdk-lib/aws-apigatewayv2";
import { CfnScalableTarget } from "aws-cdk-lib/aws-applicationautoscaling";
import { CfnTrail } from "aws-cdk-lib/aws-cloudtrail";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnStream } from "aws-cdk-lib/aws-kinesisvideo";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnConfigurationSet } from "aws-cdk-lib/aws-ses";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntRevconv5");
// A neutral `-c rev=2` redeploy flips this tag on every taggable resource — a real
// UpdateResource against each, probing post-update echo materialization for free.
Tags.of(stack).add("cdkrd:rev", String(app.node.tryGetContext("rev") ?? "1"));

// -- Lambda: RecursiveLoop + RuntimeManagementConfig probes (both undeclared) --
const fn = new LambdaFunction(stack, "Fn", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => 'ok';"),
});

// -- HTTP API: DisableExecuteApiEndpoint probe (undeclared, default false) --
new CfnApi(stack, "HttpApi", {
  name: "cdkrd-hunt-revconv5-http",
  protocolType: "HTTP",
});

// -- SES ConfigurationSet: sending/reputation toggle probes (both undeclared true) --
new CfnConfigurationSet(stack, "SesCs", { name: "cdkrd-hunt-revconv5-cs" });

// -- Kinesis Video Stream: DataRetentionInHours probe (undeclared, default 0) --
new CfnStream(stack, "Kvs", { name: "cdkrd-hunt-revconv5-kvs" });

// -- CloudTrail: EventSelectors probe. Raw L1 so EventSelectors stays UNDECLARED
//    (the L2 Trail declares management-event selectors, which would void the probe). --
const trailBucket = new Bucket(stack, "TrailBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
trailBucket.addToResourcePolicy(
  new PolicyStatement({
    sid: "AWSCloudTrailAclCheck",
    effect: Effect.ALLOW,
    principals: [new ServicePrincipal("cloudtrail.amazonaws.com")],
    actions: ["s3:GetBucketAcl"],
    resources: [trailBucket.bucketArn],
  }),
);
trailBucket.addToResourcePolicy(
  new PolicyStatement({
    sid: "AWSCloudTrailWrite",
    effect: Effect.ALLOW,
    principals: [new ServicePrincipal("cloudtrail.amazonaws.com")],
    actions: ["s3:PutObject"],
    resources: [trailBucket.arnForObjects("AWSLogs/*")],
    conditions: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" } },
  }),
);
const trail = new CfnTrail(stack, "Trail", {
  trailName: "cdkrd-hunt-revconv5-trail",
  s3BucketName: trailBucket.bucketName,
  isLogging: true,
});
trail.node.addDependency(trailBucket.policy!);

// -- AAS ScalableTarget: TWO ScheduledActions in non-alphabetical declared order --
const table = new Table(stack, "ScaleTable", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PROVISIONED,
  removalPolicy: RemovalPolicy.DESTROY,
});
const scalingRole = new Role(stack, "ScalingRole", {
  assumedBy: new ServicePrincipal("application-autoscaling.amazonaws.com"),
});
new CfnScalableTarget(stack, "ScaleTarget", {
  serviceNamespace: "dynamodb",
  resourceId: `table/${table.tableName}`,
  scalableDimension: "dynamodb:table:ReadCapacityUnits",
  minCapacity: 1,
  maxCapacity: 5,
  roleArn: scalingRole.roleArn,
  scheduledActions: [
    // one-shot schedules far in the future so neither ever fires; declared order
    // (zebra before alpha) is deliberately NOT the alphabetical echo order
    {
      scheduledActionName: "zebra-cdkrd-hunt",
      schedule: "at(2033-01-01T00:00:00)",
      scalableTargetAction: { minCapacity: 1, maxCapacity: 5 },
    },
    {
      scheduledActionName: "alpha-cdkrd-hunt",
      schedule: "at(2033-06-01T00:00:00)",
      scalableTargetAction: { minCapacity: 2, maxCapacity: 4 },
    },
  ],
});

// keep the linter quiet about the unused function handle (it is mutated out of band
// by verify.sh via its physical name, resolved from the stack)
void fn;

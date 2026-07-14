// Barest-form first-run FP probe batch 4 (real AWS): eight common types whose
// corpus/fixture coverage is RICH-only — every existing case declares most
// properties, so the undeclared-default fold surface was never exercised:
// - Synthetics::Canary (synthetics-rich declares retention/timeout/start flags)
// - CloudTrail::Trail (cloudtrail-rich = L2 Trail declares 6 props; barest = bucket + IsLogging)
// - EC2::FlowLog (only corpus case declares TrafficType/LogGroup form; barest = S3 dest,
//   TrafficType + MaxAggregationInterval undeclared)
// - WAFv2::WebACL (every corpus case declares Rules; barest = no Rules, no Name)
// - RUM::AppMonitor (rich case declares full AppMonitorConfiguration)
// - APS::Workspace (zero required properties — fully naked)
// - CodeArtifact::Domain + Repository (rich case declares policy/connections/description)
// - Bedrock::Guardrail (rich case declares all policy families; barest = word policy only)
// Stack A carries the plumbing-heavy trio (canary/trail/flowlog); stack B the rest,
// so one create-time validation failure cannot roll back the whole probe.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnWorkspace } from "aws-cdk-lib/aws-aps";
import { CfnGuardrail } from "aws-cdk-lib/aws-bedrock";
import { CfnTrail } from "aws-cdk-lib/aws-cloudtrail";
import { CfnDomain, CfnRepository } from "aws-cdk-lib/aws-codeartifact";
import { CfnFlowLog, CfnVPC } from "aws-cdk-lib/aws-ec2";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnAppMonitor } from "aws-cdk-lib/aws-rum";
import { CfnBucket, CfnBucketPolicy } from "aws-cdk-lib/aws-s3";
import { CfnCanary } from "aws-cdk-lib/aws-synthetics";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
// `-c rev=2` threads a neutral tag update through every resource — the
// post-update echo probe (redeploy with rev=2, re-check; see hunt-bugs skill).
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

// ---------------------------------------------------------------- stack A
const a = new Stack(app, "CdkrdHunt0714Barest4A");

// One bucket serves the canary artifacts, the trail delivery, and the flow-log
// delivery (policy statements for the latter two below).
const bucket = new CfnBucket(a, "Bucket", {});

new CfnBucketPolicy(a, "BucketPolicy", {
  bucket: bucket.ref,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AWSCloudTrailAclCheck",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "s3:GetBucketAcl",
        Resource: bucket.attrArn,
      },
      {
        Sid: "AWSCloudTrailWrite",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `${bucket.attrArn}/AWSLogs/${a.account}/*`,
        Condition: {
          StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" },
        },
      },
      {
        Sid: "AWSLogDeliveryAclCheck",
        Effect: "Allow",
        Principal: { Service: "delivery.logs.amazonaws.com" },
        Action: "s3:GetBucketAcl",
        Resource: bucket.attrArn,
      },
      {
        Sid: "AWSLogDeliveryWrite",
        Effect: "Allow",
        Principal: { Service: "delivery.logs.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `${bucket.attrArn}/AWSLogs/${a.account}/*`,
        Condition: {
          StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" },
        },
      },
    ],
  },
});

// Barest trail: only the two schema-required props. TrailName undeclared →
// CFn generates one (a generated-name fold probe on its own).
const trail = new CfnTrail(a, "Trail", {
  s3BucketName: bucket.ref,
  isLogging: true,
});
trail.addDependency(a.node.findChild("BucketPolicy") as CfnBucketPolicy);

const canaryRole = new Role(a, "CanaryRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
});
canaryRole.addToPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "s3:PutObject",
      "s3:GetObject",
      "s3:GetBucketLocation",
      "s3:ListAllMyBuckets",
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "cloudwatch:PutMetricData",
    ],
    resources: ["*"],
  }),
);

// Barest canary: the six schema-required props only. rate(0 hour) = run once
// on start, and StartCanaryAfterCreation is undeclared — so it never runs.
new CfnCanary(a, "Canary", {
  name: "cdkrd-hunt-brst4",
  code: {
    handler: "index.handler",
    script: 'exports.handler = async () => "ok";',
  },
  artifactS3Location: `s3://${bucket.ref}/canary`,
  executionRoleArn: canaryRole.roleArn,
  schedule: { expression: "rate(0 hour)" },
  runtimeVersion: "syn-nodejs-puppeteer-16.1",
});

const vpc = new CfnVPC(a, "Vpc", { cidrBlock: "10.61.0.0/24" });

// Barest flow log: S3 destination (no IAM role needed). TrafficType is NOT in
// the schema's `required` list but the SERVICE demands it for a VPC target
// ("traffic-type is required when the resource-type is VPC" — live-determined),
// so it is declared; MaxAggregationInterval stays undeclared as the probe.
const flowLog = new CfnFlowLog(a, "FlowLog", {
  resourceId: vpc.ref,
  resourceType: "VPC",
  trafficType: "ALL",
  logDestinationType: "s3",
  logDestination: bucket.attrArn,
});
flowLog.addDependency(a.node.findChild("BucketPolicy") as CfnBucketPolicy);

// ---------------------------------------------------------------- stack B
const b = new Stack(app, "CdkrdHunt0714Barest4B");

// Barest WebACL: no Rules, no Name (CFn generates one).
new CfnWebACL(b, "WebAcl", {
  defaultAction: { allow: {} },
  scope: "REGIONAL",
  visibilityConfig: {
    cloudWatchMetricsEnabled: false,
    metricName: "cdkrdhuntbrst4",
    sampledRequestsEnabled: false,
  },
});

// Schema requires only Name; Domain is declared because the service demands
// one domain form at create — everything else (AppMonitorConfiguration,
// CustomEvents, CwLogEnabled) stays undeclared.
new CfnAppMonitor(b, "Rum", {
  name: "cdkrd-hunt-brst4",
  domain: "example.com",
});

// Fully naked Amazon Managed Prometheus workspace (zero required props).
new CfnWorkspace(b, "Aps", {});

const caDomain = new CfnDomain(b, "CaDomain", {
  domainName: "cdkrd-hunt-brst4",
});
const caRepo = new CfnRepository(b, "CaRepo", {
  domainName: "cdkrd-hunt-brst4",
  repositoryName: "cdkrd-hunt-brst4",
});
caRepo.addDependency(caDomain);

// Barest guardrail: the three schema-required props + one word policy (the
// service rejects a guardrail with zero policies); every other policy family
// and the cross-Region/KMS knobs stay undeclared.
new CfnGuardrail(b, "Guardrail", {
  name: "cdkrd-hunt-brst4",
  blockedInputMessaging: "Blocked input.",
  blockedOutputsMessaging: "Blocked output.",
  wordPolicyConfig: { wordsConfig: [{ text: "cdkrdblockedword" }] },
});

app.synth();

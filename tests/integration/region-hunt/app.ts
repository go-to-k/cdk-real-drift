// Non-default-region first-run FP probe: every prior hunt ran in us-east-1, so a
// KNOWN_DEFAULTS constant that AWS actually varies by region (AZ set, rollout
// stage, per-region attribute families) has never been exercised. Deploy a barest
// pack of the types with the LARGEST constant/bag fold surfaces in ap-northeast-1
// and assert the first check is CLEAN; any [Potential Drift] is a region-sensitive
// default baked as a global constant. Also the FN+revert leg proves detection and
// revert plumbing in a non-default region.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnRepository } from "aws-cdk-lib/aws-ecr";
import { CfnFileSystem } from "aws-cdk-lib/aws-efs";
import {
  CfnLoadBalancer,
  CfnTargetGroup,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnRule } from "aws-cdk-lib/aws-events";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");

const s = new Stack(app, "CdkrdHunt0721Apne1", {
  env: { region: "ap-northeast-1" },
});

// ---- network: internal ALB + NLB + both TG attribute families (the biggest
// per-region attribute-bag surfaces).
const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.72.0.0/16" });
const subA = new CfnSubnet(s, "SubA", {
  vpcId: vpc.ref,
  cidrBlock: "10.72.0.0/20",
  availabilityZone: "ap-northeast-1a",
});
const subC = new CfnSubnet(s, "SubC", {
  vpcId: vpc.ref,
  cidrBlock: "10.72.16.0/20",
  availabilityZone: "ap-northeast-1c",
});
new CfnLoadBalancer(s, "Alb", {
  scheme: "internal",
  subnets: [subA.ref, subC.ref],
});
new CfnLoadBalancer(s, "Nlb", {
  scheme: "internal",
  type: "network",
  subnets: [subA.ref],
});
new CfnTargetGroup(s, "TgHttp", {
  protocol: "HTTP",
  port: 80,
  vpcId: vpc.ref,
});
new CfnTargetGroup(s, "TgTcp", {
  protocol: "TCP",
  port: 80,
  vpcId: vpc.ref,
  targetType: "ip",
});

// ---- barest compute/data/messaging types with wide KNOWN_DEFAULTS surfaces.
const role = new CfnRole(s, "FnRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  ],
});
new CfnFunction(s, "Fn", {
  code: { zipFile: 'exports.handler = async () => "ok";' },
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: role.attrArn,
});
new CfnTable(s, "Table", {
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  attributeDefinitions: [{ attributeName: "pk", attributeType: "S" }],
  provisionedThroughput: { readCapacityUnits: 1, writeCapacityUnits: 1 },
});
new CfnStream(s, "Stream", { shardCount: 1 });
new CfnQueue(s, "Queue", {});
new CfnTopic(s, "Topic", {});
new CfnBucket(s, "Bucket", {});
new CfnLogGroup(s, "Logs", {});
new CfnRepository(s, "Repo", {});
new CfnRule(s, "Rule", { scheduleExpression: "rate(1 day)" });
new CfnWorkGroup(s, "Wg", { name: "cdkrd-hunt0721-wg" });
new CfnFileSystem(s, "Efs", {});

app.synth();

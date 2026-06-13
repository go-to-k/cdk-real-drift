// Corpus-harvest fixture wave 6 (R84): common, cheap, currently-UNCOVERED CFn
// types the corpus (93 types as of R83) had never seen live — ECS
// TaskDefinition (Fargate), CodeBuild Project, WAFv2 IPSet + RuleGroup, SSM
// MaintenanceWindow + PatchBaseline, Lambda FunctionUrl, Cognito UserPoolGroup,
// EC2 LaunchTemplate + PrefixList, ApiGateway UsagePlan + ApiKey, and an
// EventBridge Pipes Pipe (SQS -> SQS). All structurally interesting (nested
// container defs, build configs, WAF rule JSON, patch rules) — exactly the
// shapes that flush out declared-compare false positives. No VPC, no NAT, no
// slow resources; everything creates/deletes in seconds.
import { App, Stack } from "aws-cdk-lib";
import { CfnApiKey, CfnRestApi, CfnUsagePlan } from "aws-cdk-lib/aws-apigateway";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { CfnUserPoolGroup } from "aws-cdk-lib/aws-cognito";
import { CfnLaunchTemplate, CfnPrefixList } from "aws-cdk-lib/aws-ec2";
import { Cluster, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnUrl, Code, Function as Fn, Runtime } from "aws-cdk-lib/aws-lambda";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";
import { RemovalPolicy } from "aws-cdk-lib";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { CfnMaintenanceWindow, CfnPatchBaseline } from "aws-cdk-lib/aws-ssm";
import { CfnIPSet, CfnRuleGroup } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkrdIntegHarvest6");

// ---- ECS Fargate TaskDefinition (nested ContainerDefinitions array — FP-prone)
const execRole = new Role(stack, "TaskExecRole", {
  assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
});
new CfnTaskDefinition(stack, "Task", {
  family: "cdkrd-harvest6",
  requiresCompatibilities: ["FARGATE"],
  networkMode: "awsvpc",
  cpu: "256",
  memory: "512",
  executionRoleArn: execRole.roleArn,
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/amazonlinux/amazonlinux:2",
      essential: true,
      command: ["sleep", "3600"],
    },
  ],
});
void Cluster; // (intentionally unused — TaskDefinition needs no cluster)

// ---- CodeBuild Project (Source/Artifacts/Environment nested structs)
const cbRole = new Role(stack, "CbRole", {
  assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
});
new CfnProject(stack, "Build", {
  name: "cdkrd-harvest6",
  serviceRole: cbRole.roleArn,
  source: { type: "NO_SOURCE", buildSpec: "version: 0.2\nphases:\n  build:\n    commands:\n      - echo hi" },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    computeType: "BUILD_GENERAL1_SMALL",
    image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
  },
});

// ---- WAFv2 IPSet + RuleGroup (REGIONAL; cheap)
new CfnIPSet(stack, "IpSet", {
  name: "cdkrd-harvest6",
  scope: "REGIONAL",
  ipAddressVersion: "IPV4",
  addresses: ["192.0.2.0/24", "198.51.100.0/24"],
});
new CfnRuleGroup(stack, "RuleGroup", {
  name: "cdkrd-harvest6",
  scope: "REGIONAL",
  capacity: 10,
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdHarvest6",
  },
  rules: [
    {
      name: "block-large-bodies",
      priority: 1,
      action: { block: {} },
      statement: { sizeConstraintStatement: {
        fieldToMatch: { body: {} },
        comparisonOperator: "GT",
        size: 8192,
        textTransformations: [{ priority: 0, type: "NONE" }],
      } },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "blockLargeBodies",
      },
    },
  ],
});

// ---- SSM MaintenanceWindow + PatchBaseline
new CfnMaintenanceWindow(stack, "Window", {
  name: "cdkrd-harvest6",
  schedule: "rate(7 days)",
  duration: 2,
  cutoff: 1,
  allowUnassociatedTargets: true,
});
new CfnPatchBaseline(stack, "Patch", {
  name: "cdkrd-harvest6",
  operatingSystem: "AMAZON_LINUX_2",
  approvalRules: {
    patchRules: [
      {
        approveAfterDays: 7,
        complianceLevel: "HIGH",
        patchFilterGroup: {
          patchFilters: [{ key: "CLASSIFICATION", values: ["Security"] }],
        },
      },
    ],
  },
});

// ---- Lambda Function + FunctionUrl
const fn = new Fn(stack, "UrlFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
});
new CfnUrl(stack, "FnUrl", { targetFunctionArn: fn.functionArn, authType: "NONE" });

// ---- Cognito UserPoolGroup
const pool = new UserPool(stack, "Pool", { removalPolicy: RemovalPolicy.DESTROY });
new CfnUserPoolGroup(stack, "Group", {
  userPoolId: pool.userPoolId,
  groupName: "cdkrd-harvest6",
  description: "harvest6 group",
  precedence: 10,
});

// ---- EC2 LaunchTemplate + managed PrefixList (no instances created)
new CfnLaunchTemplate(stack, "LaunchTpl", {
  launchTemplateName: "cdkrd-harvest6",
  launchTemplateData: {
    instanceType: "t3.micro",
    monitoring: { enabled: false },
    metadataOptions: { httpTokens: "required" },
  },
});
new CfnPrefixList(stack, "PrefixList", {
  prefixListName: "cdkrd-harvest6",
  addressFamily: "IPv4",
  maxEntries: 5,
  entries: [{ cidr: "10.0.0.0/16", description: "vpc-a" }],
});

// ---- ApiGateway UsagePlan + ApiKey (standalone; no stage binding needed)
void new CfnRestApi(stack, "Api", { name: "cdkrd-harvest6" });
new CfnUsagePlan(stack, "Plan", {
  usagePlanName: "cdkrd-harvest6",
  throttle: { rateLimit: 10, burstLimit: 5 },
  quota: { limit: 1000, period: "MONTH" },
});
new CfnApiKey(stack, "ApiKey", { name: "cdkrd-harvest6", enabled: true });

// ---- EventBridge Pipes Pipe (SQS source -> SQS target)
const src = new Queue(stack, "PipeSrc", { removalPolicy: RemovalPolicy.DESTROY });
const dst = new Queue(stack, "PipeDst", { removalPolicy: RemovalPolicy.DESTROY });
const pipeRole = new Role(stack, "PipeRole", {
  assumedBy: new ServicePrincipal("pipes.amazonaws.com"),
});
pipeRole.addToPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
  resources: [src.queueArn],
}));
pipeRole.addToPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["sqs:SendMessage"],
  resources: [dst.queueArn],
}));
new CfnPipe(stack, "Pipe", {
  name: "cdkrd-harvest6",
  roleArn: pipeRole.roleArn,
  source: src.queueArn,
  target: dst.queueArn,
  sourceParameters: { sqsQueueParameters: { batchSize: 1 } },
});

app.synth();

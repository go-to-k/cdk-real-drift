// Post-update echo probe batch 3 (see hunt-bugs skill "Post-update echo
// materialization"): ~20 common types NOT in the first two echo sweeps
// (second-deploy-echo covered Bucket/FileSystem/Function/LogGroup/Project/
// Queue/Repository/Role/Rule/StateMachine/Stream/Table/Topic/UserPool/
// WorkGroup; echo2 covered Alarm/DeliveryStream/RestApi-family/EventBus/
// ManagedPolicy/MetricFilter/Parameter/Schedule/Secret/Subscription).
// Deploy → first check → redeploy with -c rev=2 (tag update + a real
// description/body update on types that support it) → re-check: every newly
// materialized undeclared field is a latent second-deploy FP.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnApi, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import {
  CfnApplication as CfnAppConfigApplication,
  CfnConfigurationProfile,
  CfnEnvironment,
} from "aws-cdk-lib/aws-appconfig";
import { CfnDataCatalog } from "aws-cdk-lib/aws-athena";
import { CfnBackupPlan, CfnBackupVault } from "aws-cdk-lib/aws-backup";
import { CfnDashboard } from "aws-cdk-lib/aws-cloudwatch";
import { CfnApplication as CfnCodeDeployApplication } from "aws-cdk-lib/aws-codedeploy";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import {
  CfnRouteTable,
  CfnSecurityGroup,
  CfnSubnet,
  CfnVPC,
} from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import { CfnDatabase } from "aws-cdk-lib/aws-glue";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  CfnAlias,
  CfnEventInvokeConfig,
  CfnFunction,
  CfnUrl,
  CfnVersion,
} from "aws-cdk-lib/aws-lambda";
import { CfnDocument } from "aws-cdk-lib/aws-ssm";
import { CfnActivity } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = String(app.node.tryGetContext("rev") ?? "1");
if (rev !== "1") Tags.of(app).add("cdkrd:rev", rev);

const s = new Stack(app, "CdkrdHunt0715Echo3");
const acct = s.account;

// --- VPC family (tag-updated only) ---
const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.1.0.0/24" });
new CfnSubnet(s, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.1.0.0/25",
  availabilityZone: "us-east-1a",
});
new CfnRouteTable(s, "Rt", { vpcId: vpc.ref });
new CfnSecurityGroup(s, "Sg", {
  groupDescription: "cdkrd echo3 probe",
  vpcId: vpc.ref,
});

// --- ECS (cluster tag-updated; task definition re-registers a revision) ---
new CfnCluster(s, "EcsCluster", {});
new CfnTaskDefinition(s, "TaskDef", {
  family: "cdkrd-echo3",
  requiresCompatibilities: ["FARGATE"],
  networkMode: "awsvpc",
  cpu: "256",
  memory: "512",
  containerDefinitions: [
    { name: "app", image: "public.ecr.aws/docker/library/busybox:latest", essential: true },
  ],
});

// --- Cognito client (no tags — rides the pool's update) ---
const pool = new CfnUserPool(s, "Pool", {});
new CfnUserPoolClient(s, "PoolClient", { userPoolId: pool.ref });

// --- API Gateway v2 HTTP API + stage ---
const api = new CfnApi(s, "HttpApi", {
  name: "cdkrd-echo3-api",
  protocolType: "HTTP",
});
new CfnStage(s, "HttpStage", {
  apiId: api.ref,
  stageName: "$default",
  autoDeploy: true,
});

// --- AppConfig trio ---
const acApp = new CfnAppConfigApplication(s, "AcApp", { name: "cdkrd-echo3-ac" });
new CfnEnvironment(s, "AcEnv", { applicationId: acApp.ref, name: "env" });
new CfnConfigurationProfile(s, "AcProfile", {
  applicationId: acApp.ref,
  name: "profile",
  locationUri: "hosted",
});

// --- SSM document (tag-updated) ---
new CfnDocument(s, "Doc", {
  documentType: "Command",
  content: {
    schemaVersion: "2.2",
    description: "cdkrd echo3 probe",
    mainSteps: [
      { action: "aws:runShellScript", name: "noop", inputs: { runCommand: ["true"] } },
    ],
  },
});

// --- Step Functions activity / CodeDeploy application ---
new CfnActivity(s, "Activity", { name: "cdkrd-echo3-activity" });
new CfnCodeDeployApplication(s, "CdApp", {});

// --- Lambda satellite family (description threads rev = real update) ---
const fnRole = new Role(s, "FnRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
});
const fn = new CfnFunction(s, "Fn", {
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: fnRole.roleArn,
  description: `cdkrd echo3 rev${rev}`,
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
});
new CfnUrl(s, "FnUrl", { targetFunctionArn: fn.attrArn, authType: "NONE" });
new CfnEventInvokeConfig(s, "FnEic", {
  functionName: fn.ref,
  qualifier: "$LATEST",
  maximumRetryAttempts: 1,
});
const ver = new CfnVersion(s, "FnVer", { functionName: fn.ref });
new CfnAlias(s, "FnAlias", {
  functionName: fn.ref,
  functionVersion: ver.attrVersion,
  name: "live",
});

// --- CloudWatch dashboard (body threads rev = real update) ---
new CfnDashboard(s, "Dash", {
  dashboardBody: JSON.stringify({
    widgets: [
      {
        type: "text",
        x: 0,
        y: 0,
        width: 6,
        height: 3,
        properties: { markdown: `cdkrd echo3 rev${rev}` },
      },
    ],
  }),
});

// --- Backup vault + plan ---
const vault = new CfnBackupVault(s, "Vault", {
  backupVaultName: "cdkrd_echo3_vault",
});
new CfnBackupPlan(s, "Plan", {
  backupPlan: {
    backupPlanName: "cdkrd-echo3-plan",
    backupPlanRule: [
      {
        ruleName: "weekly",
        targetBackupVault: vault.attrBackupVaultName,
        scheduleExpression: "cron(0 5 ? * MON *)",
      },
    ],
  },
});

// --- Athena data catalog / Glue database (description threads rev) ---
new CfnDataCatalog(s, "Catalog", {
  name: "cdkrd_echo3_catalog",
  type: "GLUE",
  parameters: { "catalog-id": acct },
});
new CfnDatabase(s, "GlueDb", {
  catalogId: acct,
  databaseInput: {
    name: "cdkrd_echo3_db",
    description: `cdkrd echo3 rev${rev}`,
  },
});

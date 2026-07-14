// Second-deploy echo probe batch 3 (post-update echo materialization, the
// #1569 class): ~10 more common, cheap, fast, no-VPC types in their barest
// form — first check MUST be CLEAN, then a harmless stack UPDATE (tag /
// description bump via `-c rev=2`) and the check MUST STILL be clean. Any
// undeclared property materializing only after the update is a latent FP every
// real user hits on their second `cdk deploy`. Covers (echo1+echo2 swept 27
// types; these are the next-most-common uncovered ones): Cognito
// UserPoolClient, KMS Key, WAFv2 WebACL, CloudWatch Dashboard, AppConfig
// Application/Environment/ConfigurationProfile, Glue Database/Crawler/Trigger,
// SSM Document, AppSync GraphQLApi, SES ConfigurationSet, Backup Vault/Plan.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnConfigurationProfile,
  CfnEnvironment,
} from "aws-cdk-lib/aws-appconfig";
import { CfnGraphQLApi } from "aws-cdk-lib/aws-appsync";
import { CfnBackupPlan, CfnBackupVault } from "aws-cdk-lib/aws-backup";
import { CfnDashboard } from "aws-cdk-lib/aws-cloudwatch";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { CfnCrawler, CfnDatabase, CfnTrigger } from "aws-cdk-lib/aws-glue";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnKey } from "aws-cdk-lib/aws-kms";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnConfigurationSet } from "aws-cdk-lib/aws-ses";
import { CfnDocument } from "aws-cdk-lib/aws-ssm";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const rev = String(app.node.tryGetContext("rev") ?? "1");
Tags.of(app).add("cdkrd:ephemeral", "1");

const stack = new Stack(app, "CdkrdHuntEcho3");
// The update trigger: bumping this tag revs every taggable resource in the
// stack through its CFn/CC update handler — the realistic "second deploy".
Tags.of(stack).add("cdkrd:rev", rev);

const pool = new CfnUserPool(stack, "Echo3Pool", {});
new CfnUserPoolClient(stack, "Echo3PoolClient", { userPoolId: pool.ref });

new CfnKey(stack, "Echo3Key", {
  description: `cdkrd echo3 probe rev ${rev}`,
  pendingWindowInDays: 7,
});

new CfnWebACL(stack, "Echo3WebAcl", {
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: false,
    sampledRequestsEnabled: false,
    metricName: "cdkrdEcho3",
  },
  description: `cdkrd echo3 probe rev ${rev}`,
});

// Dashboard has no Tags — the body itself carries the rev (a body update IS
// the realistic second-deploy shape for dashboards).
new CfnDashboard(stack, "Echo3Dashboard", {
  dashboardName: "cdkrd-echo3-dashboard",
  dashboardBody: JSON.stringify({
    widgets: [
      {
        type: "text",
        x: 0,
        y: 0,
        width: 6,
        height: 3,
        properties: { markdown: `cdkrd echo3 probe rev ${rev}` },
      },
    ],
  }),
});

const acApp = new CfnApplication(stack, "Echo3AcApp", {
  name: "cdkrd-echo3-app",
  description: `cdkrd echo3 probe rev ${rev}`,
});
new CfnEnvironment(stack, "Echo3AcEnv", {
  applicationId: acApp.ref,
  name: "cdkrd-echo3-env",
  description: `cdkrd echo3 probe rev ${rev}`,
});
new CfnConfigurationProfile(stack, "Echo3AcProfile", {
  applicationId: acApp.ref,
  name: "cdkrd-echo3-profile",
  locationUri: "hosted",
  description: `cdkrd echo3 probe rev ${rev}`,
});

const crawlBucket = new Bucket(stack, "Echo3CrawlBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
});
const glueRole = new Role(stack, "Echo3GlueRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
});
crawlBucket.grantRead(glueRole);
new CfnDatabase(stack, "Echo3GlueDb", {
  catalogId: stack.account,
  databaseInput: {
    name: "cdkrd_echo3_db",
    description: `cdkrd echo3 probe rev ${rev}`,
  },
});
const crawler = new CfnCrawler(stack, "Echo3Crawler", {
  name: "cdkrd-echo3-crawler",
  role: glueRole.roleArn,
  databaseName: "cdkrd_echo3_db",
  targets: { s3Targets: [{ path: `s3://${crawlBucket.bucketName}/data/` }] },
  description: `cdkrd echo3 probe rev ${rev}`,
});
new CfnTrigger(stack, "Echo3Trigger", {
  name: "cdkrd-echo3-trigger",
  type: "ON_DEMAND",
  actions: [{ crawlerName: crawler.name }],
  description: `cdkrd echo3 probe rev ${rev}`,
}).addDependency(crawler);

new CfnDocument(stack, "Echo3Doc", {
  content: {
    schemaVersion: "2.2",
    description: "cdkrd echo3 probe",
    mainSteps: [
      {
        action: "aws:runShellScript",
        name: "noop",
        inputs: { runCommand: ["true"] },
      },
    ],
  },
  documentType: "Command",
  updateMethod: "NewVersion",
});

new CfnGraphQLApi(stack, "Echo3AppSync", {
  name: "cdkrd-echo3-appsync",
  authenticationType: "API_KEY",
});

new CfnConfigurationSet(stack, "Echo3SesConfigSet", {
  name: "cdkrd-echo3-configset",
});

const vault = new CfnBackupVault(stack, "Echo3BackupVault", {
  backupVaultName: "cdkrd-echo3-vault",
});
new CfnBackupPlan(stack, "Echo3BackupPlan", {
  backupPlan: {
    backupPlanName: "cdkrd-echo3-plan",
    backupPlanRule: [
      {
        ruleName: `cdkrd-echo3-rule-rev${rev}`,
        targetBackupVault: "cdkrd-echo3-vault",
        scheduleExpression: "cron(0 5 ? * 7 *)",
      },
    ],
  },
}).addDependency(vault);

app.synth();

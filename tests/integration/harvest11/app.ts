// cdk-real-drift corpus-harvest wave 11 (real AWS) — R126.
// Uncovered types weighted toward the FP-rich normalization classes — JSON policy
// docs (policy-canonical), JSON-STRING config (isJsonStringStructEqual), Map params
// (stringly), and nested declared config:
//   SecretsManager ResourcePolicy, Logs ResourcePolicy, CodeDeploy DeploymentConfig,
//   Athena DataCatalog, CodeBuild ReportGroup, SES EmailIdentity, Cognito
//   UserPoolDomain + UserPoolResourceServer, ApiGateway Model + RequestValidator,
//   Glue Crawler (JSON Configuration string), EC2 FlowLog. Each carries a few
//   NON-default declared properties so a declared-side normalization FP surfaces.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnDataCatalog } from "aws-cdk-lib/aws-athena";
import { ReportGroup, ReportGroupType } from "aws-cdk-lib/aws-codebuild";
import { CfnDeploymentConfig } from "aws-cdk-lib/aws-codedeploy";
import { ResourceServerScope, UserPool } from "aws-cdk-lib/aws-cognito";
import {
  FlowLog,
  FlowLogDestination,
  FlowLogResourceType,
  FlowLogTrafficType,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  JsonSchemaType,
  JsonSchemaVersion,
  MockIntegration,
  PassthroughBehavior,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { CfnCrawler, CfnDatabase } from "aws-cdk-lib/aws-glue";
import {
  AccountRootPrincipal,
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { LogGroup, ResourcePolicy, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { EmailIdentity, Identity } from "aws-cdk-lib/aws-ses";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest11");
const account = Stack.of(stack).account;

// --- SecretsManager Secret + ResourcePolicy (JSON policy doc → policy-canonical) ---
const secret = new Secret(stack, "Secret", {
  secretName: "cdkrd-secret",
  removalPolicy: RemovalPolicy.DESTROY,
});
secret.addToResourcePolicy(
  new PolicyStatement({
    sid: "AllowRoot",
    effect: Effect.ALLOW,
    actions: ["secretsmanager:GetSecretValue"],
    principals: [new AccountRootPrincipal()],
    resources: ["*"],
  })
);

// --- Logs ResourcePolicy (JSON policy doc) ---
new ResourcePolicy(stack, "LogsResourcePolicy", {
  resourcePolicyName: "cdkrd-logs-policy",
  policyStatements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["logs:PutLogEvents", "logs:CreateLogStream"],
      principals: [new ServicePrincipal("route53.amazonaws.com")],
      resources: ["*"],
    }),
  ],
});

// --- CodeDeploy custom DeploymentConfig ---
new CfnDeploymentConfig(stack, "DeploymentConfig", {
  deploymentConfigName: "cdkrd-deploy-config",
  computePlatform: "Server",
  minimumHealthyHosts: { type: "HOST_COUNT", value: 1 },
});

// --- Athena DataCatalog (GLUE type, Parameters Map<String,String>) ---
new CfnDataCatalog(stack, "DataCatalog", {
  name: "cdkrd_catalog",
  type: "GLUE",
  description: "cdkrd harvest data catalog",
  parameters: { "catalog-id": account },
});

// --- CodeBuild ReportGroup ---
new ReportGroup(stack, "ReportGroup", {
  reportGroupName: "cdkrd-reports",
  type: ReportGroupType.TEST,
  removalPolicy: RemovalPolicy.DESTROY,
});

// --- SES EmailIdentity (domain identity, unverified; nested DKIM/MailFrom config) ---
new EmailIdentity(stack, "EmailIdentity", {
  identity: Identity.domain("cdkrd-harvest11.example.com"),
  mailFromDomain: "mail.cdkrd-harvest11.example.com",
});

// --- Cognito UserPool + UserPoolDomain + UserPoolResourceServer ---
const userPool = new UserPool(stack, "UserPool", {
  userPoolName: "cdkrd-pool",
  removalPolicy: RemovalPolicy.DESTROY,
});
userPool.addDomain("Domain", {
  cognitoDomain: { domainPrefix: "cdkrd-harvest11-drift-pool" },
});
userPool.addResourceServer("ResourceServer", {
  identifier: "cdkrd-api",
  userPoolResourceServerName: "cdkrd-rs",
  scopes: [new ResourceServerScope({ scopeName: "read", scopeDescription: "read scope" })],
});

// --- ApiGateway RestApi + Model + RequestValidator (JSON schema; method needed to deploy) ---
const api = new RestApi(stack, "RestApi", { restApiName: "cdkrd-rest-api" });
api.root.addMethod(
  "GET",
  new MockIntegration({
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: { "application/json": '{"statusCode": 200}' },
    integrationResponses: [{ statusCode: "200" }],
  }),
  { methodResponses: [{ statusCode: "200" }] }
);
api.addModel("Model", {
  contentType: "application/json",
  modelName: "CdkrdModel",
  description: "cdkrd harvest model",
  schema: {
    schema: JsonSchemaVersion.DRAFT4,
    title: "cdkrd",
    type: JsonSchemaType.OBJECT,
    properties: { id: { type: JsonSchemaType.STRING } },
  },
});
api.addRequestValidator("RequestValidator", {
  requestValidatorName: "cdkrd-validator",
  validateRequestBody: true,
  validateRequestParameters: true,
});

// --- Glue Database + Crawler (Configuration is a JSON STRING → isJsonStringStructEqual) ---
const crawlerTarget = new Bucket(stack, "CrawlerBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
new CfnDatabase(stack, "GlueDatabase", {
  catalogId: account,
  databaseInput: { name: "cdkrd_db" },
});
const crawlerRole = new Role(stack, "CrawlerRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
});
crawlerTarget.grantRead(crawlerRole);
new CfnCrawler(stack, "Crawler", {
  name: "cdkrd-crawler",
  role: crawlerRole.roleArn,
  databaseName: "cdkrd_db",
  targets: { s3Targets: [{ path: `s3://${crawlerTarget.bucketName}/data/` }] },
  schemaChangePolicy: { updateBehavior: "LOG", deleteBehavior: "LOG" },
  recrawlPolicy: { recrawlBehavior: "CRAWL_EVERYTHING" },
  configuration: JSON.stringify({
    Version: 1.0,
    CrawlerOutput: { Partitions: { AddOrUpdateBehavior: "InheritFromTable" } },
  }),
});

// --- EC2 FlowLog (VPC -> CloudWatch Logs; nested config) ---
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const flowLogGroup = new LogGroup(stack, "FlowLogGroup", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});
new FlowLog(stack, "FlowLog", {
  resourceType: FlowLogResourceType.fromVpc(vpc),
  destination: FlowLogDestination.toCloudWatchLogs(flowLogGroup),
  trafficType: FlowLogTrafficType.ALL,
});

app.synth();

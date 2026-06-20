// CDK app for the cdk-real-drift Glue Crawler test. The existing glue-rich
// fixture covers clean-FP only; an AWS::Glue::Crawler adds a detection (FN)
// oracle the Glue Job cannot, because UpdateCrawler supports partial in-place
// updates of mutable scalars (e.g. TablePrefix) — unlike UpdateJob's full
// replace. This fixture provides both: a clean-FP check (verify.sh) over the
// crawler's nested config (SchemaChangePolicy, S3 targets) and a detect+revert
// check (verify-detect.sh) over TablePrefix.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnCrawler, CfnDatabase } from "aws-cdk-lib/aws-glue";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlueCrawlerRich");

const dataBucket = new Bucket(stack, "Data", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const db = new CfnDatabase(stack, "Db", {
  catalogId: stack.account,
  databaseInput: { name: "cdkrd_crawler_db" },
});

const role = new Role(stack, "CrawlerRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole")],
});
dataBucket.grantRead(role);

const crawler = new CfnCrawler(stack, "Crawler", {
  name: "cdkrd-crawler-rich",
  role: role.roleArn,
  databaseName: "cdkrd_crawler_db",
  targets: { s3Targets: [{ path: `s3://${dataBucket.bucketName}/data/` }] },
  schemaChangePolicy: {
    updateBehavior: "UPDATE_IN_DATABASE",
    deleteBehavior: "DEPRECATE_IN_DATABASE",
  },
  tablePrefix: "cdkrd_",
});
crawler.addDependency(db);

app.synth();

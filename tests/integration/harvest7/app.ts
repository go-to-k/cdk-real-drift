// cdk-real-drift corpus-harvest wave 7 (real AWS) — R90.
// Cheap, no-/low-dependency CFn types NOT yet in the golden corpus (the corpus had
// 115 distinct types before this wave). Deploy once, record one golden case per
// readable resource (CDKRD_CORPUS_DIR), assert ZERO declared drift on the fresh
// deploy (the false-positive invariant across many types), then destroy.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnAnomalyDetector } from "aws-cdk-lib/aws-cloudwatch";
import { CfnApplication } from "aws-cdk-lib/aws-codedeploy";
import { CfnRegistry, CfnSchema } from "aws-cdk-lib/aws-eventschemas";
import { CfnSecurityConfiguration, CfnWorkflow } from "aws-cdk-lib/aws-glue";
import { Group } from "aws-cdk-lib/aws-iam";
import { CfnQueryDefinition } from "aws-cdk-lib/aws-logs";
import { CfnCidrCollection } from "aws-cdk-lib/aws-route53";
import { CfnTemplate } from "aws-cdk-lib/aws-ses";
import { HttpNamespace } from "aws-cdk-lib/aws-servicediscovery";
import { CfnRegexPatternSet } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest7");

new CfnRegexPatternSet(stack, "RegexSet", {
  scope: "REGIONAL",
  regularExpressionList: ["^test.*", "admin"],
});

new CfnQueryDefinition(stack, "QueryDef", {
  name: "cdkrd-integ-query",
  queryString: "fields @timestamp, @message | sort @timestamp desc | limit 20",
});

const ns = new HttpNamespace(stack, "HttpNs", { name: "cdkrd-integ-ns" });
ns.createService("Svc", { name: "cdkrd-integ-svc" });

new CfnSecurityConfiguration(stack, "GlueSec", {
  name: "cdkrd-integ-glue-sec",
  encryptionConfiguration: { s3Encryptions: [{ s3EncryptionMode: "SSE-S3" }] },
});

new CfnWorkflow(stack, "GlueWf", { name: "cdkrd-integ-wf" });

const group = new Group(stack, "Group");
Tags.of(group).add("team", "platform");

new CfnCidrCollection(stack, "CidrColl", {
  name: "cdkrd-integ-cidr",
  locations: [{ locationName: "loc1", cidrList: ["10.0.0.0/24"] }],
});

const registry = new CfnRegistry(stack, "SchemaRegistry", {
  registryName: "cdkrd-integ-registry",
});
const schema = new CfnSchema(stack, "Schema", {
  registryName: "cdkrd-integ-registry",
  schemaName: "cdkrd-integ-schema",
  type: "OpenApi3",
  content: JSON.stringify({
    openapi: "3.0.0",
    info: { title: "e", version: "1.0.0" },
    paths: {},
  }),
});
schema.node.addDependency(registry); // registry must exist before the schema

new CfnApplication(stack, "CodeDeployApp", {
  applicationName: "cdkrd-integ-cd",
  computePlatform: "Lambda",
});

new CfnTemplate(stack, "SesTemplate", {
  template: {
    templateName: "cdkrd-integ-tmpl",
    subjectPart: "cdk-real-drift integ",
    textPart: "hello",
  },
});

new CfnAnomalyDetector(stack, "AnomalyDetector", {
  singleMetricAnomalyDetector: {
    namespace: "AWS/EC2",
    metricName: "CPUUtilization",
    stat: "Average",
  },
});

app.synth();

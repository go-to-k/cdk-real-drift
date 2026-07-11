// CDK app for the cdk-real-drift case-idents-min false-positive integration
// test. DECLARED-dimension CASE probes: mixed-case declared identifiers on
// types documented (or suspected) to store them lowercased, plus HTTP-header
// case in S3 CORS — none exercised by any corpus case (all declare lowercase):
// - AWS::RDS::DBParameterGroup / DBClusterParameterGroup / OptionGroup names
//   (CLI docs: "stored as a lowercase string" — same family as the guarded
//   DBInstanceIdentifier; the DBSubnetGroupName precedent shows docs can be
//   wrong either way, so live confirmation is required before any fold)
// - AWS::DMS::Endpoint EndpointIdentifier (DMS identifier family)
// - AWS::S3::Bucket CorsConfiguration AllowedHeaders/ExposeHeaders case
// A declared-tier drift on the un-mutated deploy = normalization FP.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnEndpoint } from "aws-cdk-lib/aws-dms";
import { CfnDBClusterParameterGroup, CfnDBParameterGroup, CfnOptionGroup } from "aws-cdk-lib/aws-rds";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegCaseIdentsMin");

new CfnDBParameterGroup(stack, "HuntPg", {
  dbParameterGroupName: "CdkrdHunt-Mixed-PG",
  family: "mysql8.0",
  description: "cdkrd hunt mixed-case parameter group",
});

new CfnDBClusterParameterGroup(stack, "HuntCpg", {
  dbClusterParameterGroupName: "CdkrdHunt-Mixed-CPG",
  family: "aurora-mysql8.0",
  description: "cdkrd hunt mixed-case cluster parameter group",
  parameters: { time_zone: "UTC" },
});

new CfnOptionGroup(stack, "HuntOg", {
  optionGroupName: "CdkrdHunt-Mixed-OG",
  engineName: "mysql",
  majorEngineVersion: "8.0",
  optionGroupDescription: "cdkrd hunt mixed-case option group",
  optionConfigurations: [],
});

new CfnEndpoint(stack, "HuntDmsEndpoint", {
  endpointIdentifier: "CdkrdHunt-Mixed-DMS-EP",
  endpointType: "source",
  engineName: "mysql",
  serverName: "hunt.invalid",
  port: 3306,
  username: "hunter",
  password: "cdkrd-hunt-password-1",
});

const bucket = new Bucket(stack, "HuntCorsBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
});
const cfnBucket = bucket.node.defaultChild as import("aws-cdk-lib/aws-s3").CfnBucket;
cfnBucket.corsConfiguration = {
  corsRules: [
    {
      allowedMethods: ["GET", "PUT"],
      allowedOrigins: ["https://hunt.example.org"],
      allowedHeaders: ["X-Custom-Header", "Content-Type"],
      exposedHeaders: ["ETag", "x-amz-request-id"],
    },
  ],
};

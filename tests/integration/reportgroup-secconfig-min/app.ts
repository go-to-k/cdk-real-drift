// CDK app for the cdk-real-drift reportgroup-secconfig-min false-positive
// integration test. BAREST-possible CodeBuild ReportGroup + Glue
// SecurityConfiguration — both read through SDK overrides that have ZERO
// corpus cases and ZERO fixtures, so the barest first-run path has never been
// exercised live. The ReportGroup deliberately leaves Name undeclared (the
// CFn-generated-name fold path) and declares only what the API requires.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnReportGroup } from "aws-cdk-lib/aws-codebuild";
import { CfnSecurityConfiguration } from "aws-cdk-lib/aws-glue";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegReportGroupSecConfigMin");

new CfnReportGroup(stack, "HuntReportGroup", {
  type: "TEST",
  exportConfig: {
    exportConfigType: "NO_EXPORT",
  },
});

new CfnSecurityConfiguration(stack, "HuntSecConfig", {
  name: "cdkrd-hunt-glue-secconfig",
  encryptionConfiguration: {
    s3Encryptions: [{ s3EncryptionMode: "SSE-S3" }],
  },
});

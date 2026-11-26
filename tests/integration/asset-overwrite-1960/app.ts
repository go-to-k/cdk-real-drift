// Fixture for #1960: a Glue job whose script and an ELBv2 TrustStore whose CA bundle are
// CDK FILE assets. CODE_VERSION picks the script content and CDKRD_1960_CA the PEM file, so
// a redeploy with new values is a LEGIT source redeploy (new content-addressed asset keys)
// that the #1606 stale-source void folds; verify.sh then overwrites the deployed objects
// out of band to prove the overwrite is still caught against the local cdk.out assets.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnTrustStore } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnJob } from "aws-cdk-lib/aws-glue";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Asset } from "aws-cdk-lib/aws-s3-assets";

const version = process.env.CODE_VERSION ?? "v1";
const caPem = process.env.CDKRD_1960_CA;
if (!caPem) throw new Error("CDKRD_1960_CA must point at a CA PEM file (see verify.sh)");
const dir = join(tmpdir(), "cdkrd-integ-1960");
mkdirSync(dir, { recursive: true });
const scriptPath = join(dir, `job-${version}.py`);
writeFileSync(scriptPath, `print("cdkrd #1960 ${version}")\n`);

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdInteg1960AssetOverwrite");

const script = new Asset(stack, "Script", { path: scriptPath });
const role = new Role(stack, "GlueRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole")],
});
script.grantRead(role);
new CfnJob(stack, "Job", {
  role: role.roleArn,
  command: { name: "pythonshell", pythonVersion: "3.9", scriptLocation: script.s3ObjectUrl },
  maxCapacity: 0.0625,
});

const ca = new Asset(stack, "CaBundle", { path: caPem });
new CfnTrustStore(stack, "TrustStore", {
  name: "cdkrd-integ-1960",
  caCertificatesBundleS3Bucket: ca.s3BucketName,
  caCertificatesBundleS3Key: ca.s3ObjectKey,
});

app.synth();

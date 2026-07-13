// CDK app for the cdk-real-drift variantpack-min false-positive integration test.
// Two cheap un-exercised variants in one stack:
//   - AWS::EFS::FileSystem ThroughputMode=provisioned (+ the required
//     ProvisionedThroughputInMibps) — corpus covers bursting (undeclared) and
//     elastic only; provisioned may materialize different throughput defaults.
//     L1 CfnFileSystem so no VPC / mount targets / SG are dragged along.
//   - AWS::Lambda::Function java21 + SnapStart DECLARED (PublishedVersions) —
//     lambda-java-min covers java-undeclared-SnapStart ({ApplyOn:"None"}) and
//     lambda-config-rich covers SnapStart-on-python; the declared-on-java echo
//     (SnapStartResponse / RuntimeVersionConfig) is unexercised. The handler
//     asset is a placeholder (never invoked; no version is ever published).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnFileSystem } from "aws-cdk-lib/aws-efs";
import { Code, Function as LambdaFunction, Runtime, SnapStartConf } from "aws-cdk-lib/aws-lambda";
import * as path from "node:path";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714VariantPack");

new CfnFileSystem(stack, "HuntEfsProvisioned", {
  throughputMode: "provisioned",
  provisionedThroughputInMibps: 1,
});

new LambdaFunction(stack, "HuntJavaSnapStartFn", {
  runtime: Runtime.JAVA_21,
  handler: "example.Handler::handleRequest",
  code: Code.fromAsset(path.join(import.meta.dirname, "handler")),
  snapStart: SnapStartConf.ON_PUBLISHED_VERSIONS,
});

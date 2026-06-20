// CDK app for the cdk-real-drift CloudWatch Logs LogGroup false-positive test.
// A KMS-encrypted log group with an explicit retention is one of the most common
// "production logging" patterns. It exercises a customer KMS key (KmsKeyId on the
// log group + a CloudWatch-Logs service-principal key policy with an Fn::Sub
// region intrinsic), an explicit RetentionInDays, and tags. A freshly deployed +
// recorded log group with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLogsRich");

const key = new Key(stack, "LogsKey", {
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.DESTROY,
});
// CloudWatch Logs must be granted use of the CMK (regional service principal).
key.addToResourcePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    principals: [new ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
    actions: [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ],
    resources: ["*"],
  })
);

const lg = new LogGroup(stack, "Lg", {
  logGroupName: "/cdkrd/logs-rich",
  retention: RetentionDays.TWO_WEEKS,
  encryptionKey: key,
  removalPolicy: RemovalPolicy.DESTROY,
});
Tags.of(lg).add("app", "cdkrd");
Tags.of(lg).add("env", "test");

app.synth();

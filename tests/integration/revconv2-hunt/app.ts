// Revert-convergence probe (the #1571 class, batch 3): six KNOWN_DEFAULTS/atDefault-
// folded, MUTABLE surfaces whose revert convergence has never been live-proven —
// DynamoDB PointInTimeRecoverySpecification, S3 VersioningConfiguration, Logs
// LogGroup RetentionInDays, ECR ImageScanningConfiguration.ScanOnPush, Events
// EventBus LogConfig (fold added in #1596, detection+revert never live-proven),
// Kinesis StreamModeDetails PROVISIONED->ON_DEMAND (the #1596 fold's mode-switch
// detection + revert). Each is mutated out of band, must be DETECTED, then
// `revert` must actually restore the LIVE value (some Cloud Control handlers
// no-op an omitted property -> REVERT_SET_DEFAULT_PATHS candidates; the API
// shape is not a predictor, only a live test answers).
// Deliberately EXCLUDED (AWS-side rate limits make an in-run revert impossible,
// not a cdkrd bug): DDB TimeToLiveSpecification (1 change/hour), EFS
// ThroughputMode (1 change/24h).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { CfnRepository } from "aws-cdk-lib/aws-ecr";
import { CfnEventBus } from "aws-cdk-lib/aws-events";
import { CfnStream } from "aws-cdk-lib/aws-kinesis";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnBucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714RevConv2");

const table = new CfnTable(stack, "Conv2Table", {
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  attributeDefinitions: [{ attributeName: "pk", attributeType: "S" }],
  billingMode: "PAY_PER_REQUEST",
});
table.applyRemovalPolicy(RemovalPolicy.DESTROY);

new CfnBucket(stack, "Conv2Bucket", {});
new CfnLogGroup(stack, "Conv2LogGroup", {});
new CfnRepository(stack, "Conv2Repo", {});
new CfnEventBus(stack, "Conv2Bus", { name: "cdkrd-hunt0714-conv2-bus" });
new CfnStream(stack, "Conv2Stream", { shardCount: 1 });

app.synth();

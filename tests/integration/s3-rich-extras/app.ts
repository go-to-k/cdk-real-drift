// S3 bucket exercising rich sub-configs NOT in s3-rich: inventory + metrics
// configurations (object arrays — reorder-FP candidates), ownership controls,
// EventBridge notification, transfer acceleration, and intelligent-tiering with
// multiple tierings. S3 is the #1 daily-driver type; these are common but untested
// surfaces. Clean record->check is the FP oracle.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Bucket, ObjectOwnership } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3RichExtras");

const dest = new Bucket(stack, "Dest", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

new Bucket(stack, "Data", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  transferAcceleration: true,
  eventBridgeEnabled: true,
  objectOwnership: ObjectOwnership.OBJECT_WRITER,
  intelligentTieringConfigurations: [
    { name: "logsTier", prefix: "logs/", archiveAccessTierTime: Duration.days(90) },
    {
      name: "dataTier",
      prefix: "data/",
      archiveAccessTierTime: Duration.days(90),
      deepArchiveAccessTierTime: Duration.days(180),
    },
  ],
  metrics: [
    { id: "EntireBucket" },
    { id: "LogsOnly", prefix: "logs/" },
  ],
  inventories: [
    { destination: { bucket: dest, prefix: "inv1" }, enabled: true, inventoryId: "inv-daily" },
    { destination: { bucket: dest, prefix: "inv2" }, enabled: true, inventoryId: "inv-weekly" },
  ],
});

app.synth();

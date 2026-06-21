// CDK app for the cdk-real-drift S3 cross-bucket replication false-positive test.
// S3 is the most commonly deployed resource and the existing s3-rich fixture
// covers CORS / lifecycle / intelligent-tiering — but NOT ReplicationConfiguration,
// a notoriously normalization-heavy nested config (a Rules array with Filter /
// Priority / Destination / StorageClass / DeleteMarkerReplication /
// SourceSelectionCriteria, plus the auto-generated replication IAM role). A
// freshly deployed + recorded source bucket with NO out-of-band change MUST report
// CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Bucket, StorageClass } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegS3ReplicationRich");

const dest = new Bucket(stack, "Dest", {
  versioned: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

const source = new Bucket(stack, "Source", {
  versioned: true,
  removalPolicy: RemovalPolicy.DESTROY,
  replicationRules: [
    {
      destination: dest,
      priority: 1,
      id: "logs-rule",
      storageClass: StorageClass.INFREQUENT_ACCESS,
      deleteMarkerReplication: false,
      replicaModifications: true,
      filter: { prefix: "logs/" },
    },
  ],
});

Tags.of(source).add("team", "platform");

app.synth();

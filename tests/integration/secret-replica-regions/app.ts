// CDK app for the cdk-real-drift SecretsManager Secret ReplicaRegions SET FP test.
// A multi-region (DR) Secret's `ReplicaRegions` is a SET of {Region, KmsKeyId} the
// CFn schema marks insertionOrder:false. Its element key is `Region`, which is NOT
// one of cdkrd's IDENTITY_FIELDS (Key/Id/AttributeName/IndexName/Name), so a keyed
// canonicalizer cannot align a reorder. The two replica regions are declared in
// DELIBERATELY non-sorted order (us-west-2 before eu-west-1); if Secrets Manager
// echoes the list sorted by Region, a positional compare false-flags every shifted
// replica as declared drift on a freshly recorded secret. A replica secret carries
// no value/data, so it is cheap. A clean record -> check MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSecretReplicaRegions");

new Secret(stack, "Secret", {
  secretName: "cdkrd-secret-replica-regions",
  // Replica regions declared NON-sorted (us-west-2 before eu-west-1).
  replicaRegions: [
    { region: "us-west-2" },
    { region: "eu-west-1" },
  ],
});

app.synth();

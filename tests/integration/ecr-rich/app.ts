// CDK app for the cdk-real-drift richly-configured ECR repository false-positive
// test. ECR repositories are a near-universal companion to any container workload;
// existing coverage is only incidental (harvest corpus / mutation fixtures), never a
// deploy-verified FP integ. This one exercises the knobs that each add a
// normalization edge: ImageScanningConfiguration (ScanOnPush nested boolean),
// ImageTagMutability (a MUTABLE enum — the FN oracle below toggles it), a
// LifecyclePolicy (CFn stores it as a STRINGIFIED JSON document — the classic
// free-form / re-serialization edge), and KMS EncryptionConfiguration (an intrinsic
// key ref). A freshly deployed + recorded repository with NO out-of-band change MUST
// report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  Repository,
  RepositoryEncryption,
  TagMutability,
} from "aws-cdk-lib/aws-ecr";
import { Key } from "aws-cdk-lib/aws-kms";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEcrRich");

const key = new Key(stack, "RepoKey", {
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

const repo = new Repository(stack, "Images", {
  imageScanOnPush: true,
  imageTagMutability: TagMutability.IMMUTABLE,
  encryption: RepositoryEncryption.KMS,
  encryptionKey: key,
  emptyOnDelete: true,
  removalPolicy: RemovalPolicy.DESTROY,
});
repo.addLifecycleRule({ maxImageCount: 10, description: "keep last 10 images" });
Tags.of(repo).add("team", "platform");
Tags.of(repo).add("cost-center", "1234");

app.synth();

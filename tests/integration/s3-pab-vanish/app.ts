// CDK app for the cdk-real-drift #1637 vanished-observed-default integration test.
// A barest bucket (no declared PublicAccessBlockConfiguration) reads the all-true
// AWS default at deploy; `record` persists the observation (baseline
// `observedDefaults`), and an out-of-band `aws s3api delete-public-access-block`
// — which removes the WHOLE property from the Cloud Control read, silently opening
// the bucket to public ACLs/policies — must surface as drift and revert back to
// the all-true default. Pre-#1637 this deletion was structurally invisible (no
// live value for any pin gate to see).
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdVerify1637PabVanish");

new Bucket(stack, "Bucket", { removalPolicy: RemovalPolicy.DESTROY });

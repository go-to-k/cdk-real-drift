// CloudFront LEGACY Origin Access Identity (OAI) fixture — reproduces the S3
// BucketPolicy principal-form false positive (ported concern from cdkd #871).
//
// `bucket.grantRead(oai)` writes a BucketPolicy whose statement Principal is
// `{ CanonicalUser: <oai S3CanonicalUserId> }`. The open question this fixture
// answers against REAL AWS: what does `GetBucketPolicy` return on read-back —
// the same `CanonicalUser` form, or the equivalent
// `{ AWS: "arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity <id>" }`
// form? If the two differ, cdkrd's declared(template)-vs-live(GetBucketPolicy)
// compare fires a false declared drift on the bucket policy.
//
// No Distribution is created — the principal-form divergence lives entirely on
// the BucketPolicy, so this stays a fast deploy (seconds, no CF propagation).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { OriginAccessIdentity } from "aws-cdk-lib/aws-cloudfront";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkrdIntegCloudfrontOai");

const assets = new Bucket(stack, "Assets", {
  removalPolicy: RemovalPolicy.DESTROY,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
});

const oai = new OriginAccessIdentity(stack, "Oai", {
  comment: "cdkrd oai fixture",
});

// Adds AWS::S3::BucketPolicy at Assets/Policy with a CanonicalUser principal.
assets.grantRead(oai);

app.synth();

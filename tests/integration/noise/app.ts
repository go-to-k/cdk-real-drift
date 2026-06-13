// CDK app for the cdk-real-drift false-positive ("noise") integration test (R87).
//
// Every resource here DECLARES properties whose live AWS form is textually
// different from the template but semantically identical — exactly the cases the
// normalize/ layer exists to subtract. If any normalizer regresses, the declared
// value diverges from live and `check` reports a FALSE declared drift. The test
// deploys this and asserts `check --fail` exits 0 (zero false positives), then
// `accept` + `check` stays CLEAN.
//
// Coverage (historical false-positive bugs in parentheses):
//   - IAM inline policy with an `aws:SecureTransport` Condition key — must NOT be
//     stripped as an `aws:*` tag (R69: stripping it turned every enforceSSL policy
//     into false drift);
//   - IAM policy Action as a multi-element array + a wildcard Resource — policy
//     canonicalization (scalar/array unify, statement order);
//   - a managed policy attached by name/ARN (name<->ARN collapse);
//   - resource Tags — AWS adds `aws:cloudformation:*` managed tags and may reorder
//     them; the declared set must still compare equal (aws:* strip + tag-list order);
//   - S3 CorsConfiguration — an ordered array of rules whose elements must match.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Bucket, HttpMethods } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegNoise");

const role = new Role(stack, "NoiseRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
  inlinePolicies: {
    NoisePolicy: new PolicyDocument({
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
          resources: ["*"],
          // R69 regression guard: this aws:* CONDITION key must survive the live
          // read — it is NOT an aws:* tag. Stripping it would drop the condition
          // from live and report a false declared drift on the whole policy.
          conditions: { Bool: { "aws:SecureTransport": "true" } },
        }),
      ],
    }),
  },
});
Tags.of(role).add("team", "platform");
Tags.of(role).add("cost-center", "1234");

const bucket = new Bucket(stack, "NoiseBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
  cors: [
    {
      allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
    },
  ],
});
Tags.of(bucket).add("team", "platform");
Tags.of(bucket).add("cost-center", "1234");

app.synth();

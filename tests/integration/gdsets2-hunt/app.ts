// Unexercised GuardDuty adapter probes (real AWS): ThreatEntitySet /
// TrustedEntitySet (compositeChildFirstWith DetectorId — pi is [Id, DetectorId])
// and PublishingDestination (compositeWith DetectorId — pi is [DetectorId, Id])
// all have CC_IDENTIFIER_ADAPTERS entries with zero corpus and zero fixtures;
// a wrong composite order silently skips every read (#1523 class). Also a
// Filter with UNDECLARED Action (folds KNOWN_DEFAULTS 'NOOP') for verify.sh's
// OOB mutate -> detect -> revert -> live-convergence probe.
// The entity-set list files are pre-uploaded out of band by verify.sh
// (GD_BUCKET env); the findings-export bucket + KMS key are in-stack.
// Entity sets use raw CfnResource — the L1s are newer than some aws-cdk-lib 2.x.
import { App, CfnResource, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnDetector, CfnFilter, CfnPublishingDestination } from "aws-cdk-lib/aws-guardduty";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Bucket } from "aws-cdk-lib/aws-s3";

const listBucket = process.env.GD_BUCKET;
if (!listBucket) throw new Error("GD_BUCKET env is required (set by verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722Gd2");

const detector = new CfnDetector(stack, "HuntDetector", { enable: true });

new CfnResource(stack, "HuntThreatEntitySet", {
  type: "AWS::GuardDuty::ThreatEntitySet",
  properties: {
    DetectorId: detector.ref,
    Name: "cdkrd-hunt0722-threat-entity-set",
    Format: "TXT",
    Location: `https://s3.amazonaws.com/${listBucket}/threatlist.txt`,
    Activate: true,
  },
});

new CfnResource(stack, "HuntTrustedEntitySet", {
  type: "AWS::GuardDuty::TrustedEntitySet",
  properties: {
    DetectorId: detector.ref,
    Name: "cdkrd-hunt0722-trusted-entity-set",
    Format: "TXT",
    Location: `https://s3.amazonaws.com/${listBucket}/trustedlist.txt`,
    Activate: true,
  },
});

new CfnFilter(stack, "HuntFilter", {
  detectorId: detector.ref,
  name: "cdkrd-hunt0722-filter",
  findingCriteria: {
    criterion: { severity: { Gte: 4 } },
  },
});

// Findings-export destination: in-stack bucket + KMS key with GuardDuty grants.
const exportKey = new Key(stack, "HuntExportKey", {
  removalPolicy: RemovalPolicy.DESTROY,
  description: "cdkrd gdsets2-hunt findings export key",
});
exportKey.addToResourcePolicy(
  new PolicyStatement({
    principals: [new ServicePrincipal("guardduty.amazonaws.com")],
    actions: ["kms:GenerateDataKey"],
    resources: ["*"],
  }),
);

// No autoDeleteObjects: its custom-resource Lambda is a `skipped=` line the
// verify.sh zero-skip assert would trip on; delstack force-deletes the
// non-empty bucket at teardown anyway.
const exportBucket = new Bucket(stack, "HuntExportBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
});
exportBucket.addToResourcePolicy(
  new PolicyStatement({
    principals: [new ServicePrincipal("guardduty.amazonaws.com")],
    actions: ["s3:GetBucketLocation"],
    resources: [exportBucket.bucketArn],
  }),
);
exportBucket.addToResourcePolicy(
  new PolicyStatement({
    principals: [new ServicePrincipal("guardduty.amazonaws.com")],
    actions: ["s3:PutObject"],
    resources: [exportBucket.arnForObjects("*")],
  }),
);

const pubDest = new CfnPublishingDestination(stack, "HuntPubDest", {
  detectorId: detector.ref,
  destinationType: "S3",
  destinationProperties: {
    destinationArn: exportBucket.bucketArn,
    kmsKeyArn: exportKey.keyArn,
  },
});
if (exportBucket.policy) pubDest.addDependency(exportBucket.policy.node.defaultChild as CfnResource);

app.synth();

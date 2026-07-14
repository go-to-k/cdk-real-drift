// Adapter-family probe (real AWS): the GuardDuty sub-resource
// CC_IDENTIFIER_ADAPTERS entries (Filter / IPSet / ThreatIntelSet) have zero
// corpus and zero fixture coverage — only the Detector itself was ever read.
// Their primaryIdentifier is composite (DetectorId + child id) while the CFn
// physical id is only the child segment, so a wrong adapter order silently
// skips every read (the #1523 class: a throwing reader looks CLEAN). This
// deploys the barest detector + the three children and asserts the first
// check is CLEAN (reads resolve + defaults fold).
// The IP/threat list files are pre-uploaded out of band by verify.sh (bucket
// via GD_BUCKET env) — GuardDuty validates the S3 location at create.
// PublishingDestination (bucket-policy + KMS plumbing) is deferred.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDetector, CfnFilter, CfnIPSet, CfnThreatIntelSet } from "aws-cdk-lib/aws-guardduty";

const bucket = process.env.GD_BUCKET;
if (!bucket) throw new Error("GD_BUCKET env is required (set by verify.sh)");

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714Gd");

const detector = new CfnDetector(stack, "HuntDetector", { enable: true });

new CfnFilter(stack, "HuntFilter", {
  detectorId: detector.ref,
  name: "cdkrd-hunt0714-filter",
  findingCriteria: {
    criterion: { severity: { Gte: 4 } },
  },
});

new CfnIPSet(stack, "HuntIpSet", {
  detectorId: detector.ref,
  name: "cdkrd-hunt0714-ipset",
  format: "TXT",
  location: `https://s3.amazonaws.com/${bucket}/iplist.txt`,
  activate: true,
});

new CfnThreatIntelSet(stack, "HuntThreatSet", {
  detectorId: detector.ref,
  name: "cdkrd-hunt0714-threatset",
  format: "TXT",
  location: `https://s3.amazonaws.com/${bucket}/threatlist.txt`,
  activate: true,
});

app.synth();

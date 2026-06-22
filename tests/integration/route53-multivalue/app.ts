// CDK app for the cdk-real-drift Route53 RecordSet multi-value false-positive test.
// A RecordSet's ResourceRecords list is SET-LIKE: Route53 stores the values and
// commonly echoes them back in its own canonicalized (not the declared) order. A
// multi-value TXT or A record therefore reorders relative to the template, and a
// positional compare on the declared ResourceRecords array would false-drift.
// ResourceRecords is NOT in any UNORDERED_* suppression set (UNORDERED_ARRAY_PROPS /
// UNORDERED_OBJECT_ARRAY_PROPS / UNORDERED_NESTED_OBJECT_ARRAY_PATHS), so this
// freshly deployed + recorded record with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnHostedZone, CfnRecordSet } from "aws-cdk-lib/aws-route53";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRoute53Multivalue");

// Public hosted zone. A non-reserved placeholder domain (example.com / .test etc. are
// AWS-reserved and rejected) — the zone is not authoritative but the zone + its
// stack-managed records create fine, and delstack tears them down with it.
const zone = new CfnHostedZone(stack, "Zone", {
  name: "cdkrd-fphunt-x9z7q.com.",
});

// TXT record with multiple values declared in a deliberately NON-alphabetical order;
// Route53 returns them in its own canonical order, so a positional compare would FP.
new CfnRecordSet(stack, "TxtRecord", {
  hostedZoneId: zone.ref,
  name: "multi.cdkrd-fphunt-x9z7q.com.",
  type: "TXT",
  ttl: "300",
  resourceRecords: ['"zeta-value"', '"alpha-value"', '"mike-value"'],
});

// A record with multiple IPs in non-sorted order — same set-like reorder class.
new CfnRecordSet(stack, "ARecord", {
  hostedZoneId: zone.ref,
  name: "a.cdkrd-fphunt-x9z7q.com.",
  type: "A",
  ttl: "300",
  resourceRecords: ["203.0.113.30", "203.0.113.10", "203.0.113.20"],
});

app.synth();

// cdk-real-drift Route53 RecordSet detect->revert->clean integration test.
// AWS::Route53::RecordSet is read via the ListResourceRecordSets SDK override (Cloud
// Control cannot read it) and had NO writer — `revert` said "type not revertable yet"
// while detection worked, so a console edit to a record (TTL/values/weight/alias/health
// check) was detected but could not be undone. The new writeRoute53RecordSet
// (ChangeResourceRecordSets UPSERT) closes that gap. verify.sh mutates the declared TTL
// out of band, asserts check DETECTS it, reverts, asserts check CLEAN + live TTL restored.
// Uses a non-reserved placeholder domain (a public zone for a domain you don't own still
// creates fine; .com/.test/.example are NOT — example.* is AWS-reserved).
import { App, Duration, Stack } from "aws-cdk-lib";
import { ARecord, PublicHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRoute53RecordRevert");

const zone = new PublicHostedZone(stack, "Zone", {
  zoneName: "cdkrd-revert-x9z7q.com",
});

new ARecord(stack, "Rec", {
  zone,
  recordName: "www",
  target: RecordTarget.fromIpAddresses("203.0.113.10"),
  ttl: Duration.minutes(5), // declared TTL 300 — the revert subject
});

app.synth();

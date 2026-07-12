// CDK app for the cdk-real-drift cloudmap-public-min false-positive integration test.
// BAREST-possible AWS::ServiceDiscovery::PublicDnsNamespace (+ a DNS Service):
// the namespace's SDK-override reader exists but only the Private/Http variants
// were ever exercised. The FQDN-shaped Name also probes the trailing-dot echo
// (only the Route53 family is in TRAILING_DOT_PATHS today).
// NOTE: the domain is a placeholder we do not own — the public hosted zone
// creates fine and is simply non-authoritative ($0.50, deleted with the stack).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Duration, Stack, Tags } from "aws-cdk-lib";
import { DnsRecordType, PublicDnsNamespace } from "aws-cdk-lib/aws-servicediscovery";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713CloudmapPub");

const ns = new PublicDnsNamespace(stack, "HuntPublicNs", {
  name: "cdkrd-hunt-x9z7q.com",
});

ns.createService("HuntService", {
  name: "hunt-svc",
  dnsRecordType: DnsRecordType.A,
  dnsTtl: Duration.seconds(60),
});

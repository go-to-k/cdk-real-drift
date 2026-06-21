// CDK app for the cdk-real-drift opensearch-rich false-positive integration test.
// An OpenSearch Service Domain is a property-RICH, security-sensitive resource a large
// fraction of search/log users deploy: a cluster config, an EBS volume, node-to-node
// encryption, encryption-at-rest, and enforced HTTPS / a domain endpoint TLS policy.
// AWS folds each of these into its own model with server-side defaults (e.g. a default
// TLSSecurityPolicy, an auto-generated KMS key for at-rest encryption, software-update
// options) — so a clean `record`->`check` is a strong false-positive oracle for the
// OpenSearch normalization / default-folding path. Single data node + small EBS keep
// the (slow ~10-15 min) deploy as cheap as a real domain allows.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { EbsDeviceVolumeType } from "aws-cdk-lib/aws-ec2";
import { Domain, EngineVersion } from "aws-cdk-lib/aws-opensearchservice";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegOpensearchRich");

new Domain(stack, "Domain", {
  domainName: "cdkrd-opensearch-rich",
  version: EngineVersion.OPENSEARCH_2_13,
  removalPolicy: RemovalPolicy.DESTROY,
  capacity: {
    dataNodes: 1,
    dataNodeInstanceType: "t3.small.search",
    multiAzWithStandbyEnabled: false,
  },
  ebs: {
    volumeSize: 10,
    volumeType: EbsDeviceVolumeType.GP3,
  },
  zoneAwareness: { enabled: false },
  nodeToNodeEncryption: true,
  encryptionAtRest: { enabled: true },
  enforceHttps: true,
});

app.synth();

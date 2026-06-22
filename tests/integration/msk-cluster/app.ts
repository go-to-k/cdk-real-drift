// CDK app for the cdk-real-drift MSK *provisioned* Cluster (AWS::MSK::Cluster)
// KafkaVersion false-positive probe.
//
// HYPOTHESIS UNDER TEST — "partial -> concrete version" FP class:
//   Some AWS resource types RESOLVE a partial (major/minor) version the template
//   declares into the full patch version they actually provision — e.g. RDS
//   DBInstance EngineVersion declared "8.0" reads back "8.0.45". cdkrd suppresses
//   that via VERSION_PREFIX_PATHS (normalize/noise.ts), which today lists ONLY
//   RDS DBInstance + DBCluster. MSK is NOT in that set. So IF MSK accepted a
//   2-segment "3.6" and DescribeCluster echoed a more-specific "3.6.0", cdkrd
//   would false-drift on KafkaVersion (declared "3.6" vs live "3.6.0").
//
// DETERMINATION (probed real AWS, ap-northeast-1):
//   `aws kafka list-kafka-versions` returns the EXACT, canonical accepted strings:
//   ... 2.8.1, 3.4.0, 3.5.1, 3.6.0, 3.6.0.1, 3.7.x, 3.8.x, 4.0.x.kraft ...
//   MSK CreateCluster VALIDATES KafkaVersion against that supported-version list
//   and REJECTS any unlisted value. A 2-segment "3.6" is NOT a listed string, so
//   it is rejected at create time — you cannot declare a partial version that AWS
//   would later expand. DescribeCluster echoes back the literal string you
//   supplied. Therefore for AWS::MSK::Cluster declared == live and the
//   partial->concrete KafkaVersion FP is NOT REPRODUCIBLE.
//
//   (For older versions the canonical form is 3-segment, e.g. "3.6.0" / "2.8.1";
//   note "2.4.1.1" / "3.6.0.1" are 4-segment and the newest are "3.8.x" /
//   "4.0.x.kraft" — but all are fixed literals you must declare verbatim.)
//
// This fixture therefore deploys with the CANONICAL "3.6.0" and serves as a
// baseline clean check (record -> check MUST be CLEAN) for the provisioned
// Cluster type, which — unlike the existing msk-serverless fixture — DOES carry a
// KafkaVersion property. It is NOT a positive reproduction of the FP.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnCluster } from "aws-cdk-lib/aws-msk";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMskCluster");

// Minimal isolated-subnet VPC: brokers go in PRIVATE_ISOLATED subnets and need no
// NAT (natGateways: 0 keeps it cheapest). 2 AZs -> numberOfBrokerNodes must be a
// multiple of 2.
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});
const clientSubnets = vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds;

// L1 Cfn for full control of the literal KafkaVersion string. "3.6.0" is the exact
// canonical form from list-kafka-versions (declared == live, no FP). Use the cheap
// kafka.t3.small broker with the smallest allowed EBS volume.
new CfnCluster(stack, "Cluster", {
  clusterName: "cdkrd-fp-msk",
  kafkaVersion: "3.6.0",
  numberOfBrokerNodes: 2,
  brokerNodeGroupInfo: {
    instanceType: "kafka.t3.small",
    clientSubnets,
    storageInfo: { ebsStorageInfo: { volumeSize: 10 } },
  },
});

app.synth();

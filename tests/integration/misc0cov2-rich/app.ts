// CDK app for the cdk-real-drift misc0cov2-rich false-positive integration test.
// A second grab bag of cheap, fast, zero-coverage common types (all CC-readable,
// probed via describe-type before deploy):
// - AWS::EC2::PlacementGroup x2 (spread w/ SpreadLevel + partition w/ count —
//   enum-cased Strategy is a case-normalization probe)
// - AWS::ECR::PullThroughCacheRule (AWS derives UpstreamRegistry from the
//   declared UpstreamRegistryUrl — a derived-undeclared-prop probe)
// - AWS::Oam::Sink (Policy is a JSON OBJECT prop — object<->string shape probe)
// - AWS::EC2::IPAM (tier=free so no per-IP billing; AWS fills default scopes /
//   resource-discovery attrs — undeclared-fill probe)
// - AWS::EC2::TrafficMirrorFilter + 2 FilterRules (numbered rules, enum-cased
//   RuleAction/TrafficDirection)
// A clean `record`->`check` is the FP oracle.
import { App, Stack } from "aws-cdk-lib";
import {
  CfnIPAM,
  CfnPlacementGroup,
  CfnTrafficMirrorFilter,
  CfnTrafficMirrorFilterRule,
} from "aws-cdk-lib/aws-ec2";
import { CfnPullThroughCacheRule } from "aws-cdk-lib/aws-ecr";
import { CfnSink } from "aws-cdk-lib/aws-oam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMisc0Cov2Rich");

new CfnPlacementGroup(stack, "HuntPgSpread", {
  strategy: "spread",
  spreadLevel: "rack",
  tags: [{ key: "Name", value: "cdkrd-hunt-pg-spread" }],
});

new CfnPlacementGroup(stack, "HuntPgPartition", {
  strategy: "partition",
  partitionCount: 3,
  tags: [{ key: "Name", value: "cdkrd-hunt-pg-partition" }],
});

new CfnPullThroughCacheRule(stack, "HuntPtcr", {
  ecrRepositoryPrefix: "cdkrd-hunt-ecrpub",
  upstreamRegistryUrl: "public.ecr.aws",
});

new CfnSink(stack, "HuntOamSink", {
  name: "cdkrd-hunt-sink",
  policy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: stack.account },
        Resource: "*",
        Action: ["oam:CreateLink", "oam:UpdateLink"],
        Condition: {
          "ForAllValues:StringEquals": {
            "oam:ResourceTypes": ["AWS::CloudWatch::Metric", "AWS::Logs::LogGroup"],
          },
        },
      },
    ],
  },
  tags: { Name: "cdkrd-hunt-sink" },
});

new CfnIPAM(stack, "HuntIpam", {
  description: "cdkrd hunt free-tier IPAM",
  tier: "free",
  operatingRegions: [{ regionName: "us-east-1" }],
  tags: [{ key: "Name", value: "cdkrd-hunt-ipam" }],
});

const tmFilter = new CfnTrafficMirrorFilter(stack, "HuntTmFilter", {
  description: "cdkrd hunt traffic mirror filter",
  tags: [{ key: "Name", value: "cdkrd-hunt-tmf" }],
});

new CfnTrafficMirrorFilterRule(stack, "HuntTmRuleIn", {
  trafficMirrorFilterId: tmFilter.ref,
  trafficDirection: "ingress",
  ruleNumber: 100,
  ruleAction: "accept",
  protocol: 6,
  sourceCidrBlock: "10.0.0.0/8",
  destinationCidrBlock: "0.0.0.0/0",
  sourcePortRange: { fromPort: 1024, toPort: 65535 },
  destinationPortRange: { fromPort: 443, toPort: 443 },
  description: "cdkrd hunt ingress rule",
});

new CfnTrafficMirrorFilterRule(stack, "HuntTmRuleOut", {
  trafficMirrorFilterId: tmFilter.ref,
  trafficDirection: "egress",
  ruleNumber: 200,
  ruleAction: "reject",
  sourceCidrBlock: "0.0.0.0/0",
  destinationCidrBlock: "192.168.0.0/16",
  description: "cdkrd hunt egress rule",
});

app.synth();

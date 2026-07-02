// CDK app for the cdk-real-drift resolver-rich false-positive integration test.
// Route53 Resolver hybrid-DNS staple (zero corpus coverage — the corpus only has
// the Resolver FIREWALL family):
// - AWS::Route53Resolver::ResolverEndpoint (OUTBOUND, 2 ENIs) — single Do53
//   protocol (a multi-protocol endpoint rejects rule creation, RSLVR-00726;
//   Protocols reorder is auto-folded via insertionOrder:false anyway).
// - AWS::Route53Resolver::ResolverRule (FORWARD) — DomainName is declared
//   WITHOUT a trailing dot (TRAILING_DOT_PATHS only guards HostedZone Name — a
//   predicted unguarded FP if the live read appends the dot); TargetIps is
//   declared NON-sorted (.54 before .53) as an object-array reorder probe, with
//   string ports.
// - AWS::Route53Resolver::ResolverRuleAssociation.
// A clean `record`->`check` is the FP oracle; verify-detect.sh mutates the
// mutable ResolverRule TargetIps out of band for the FN half.
import { App, CfnOutput, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  CfnResolverEndpoint,
  CfnResolverRule,
  CfnResolverRuleAssociation,
} from "aws-cdk-lib/aws-route53resolver";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegResolverRich");

const vpc = new Vpc(stack, "HuntVpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});

const sg = new SecurityGroup(stack, "HuntResolverSg", {
  vpc,
  description: "cdkrd hunt resolver endpoint",
  allowAllOutbound: true,
});

const endpoint = new CfnResolverEndpoint(stack, "HuntOutboundEndpoint", {
  name: "cdkrd-hunt-outbound",
  direction: "OUTBOUND",
  securityGroupIds: [sg.securityGroupId],
  ipAddresses: vpc.isolatedSubnets.map((s) => ({ subnetId: s.subnetId })),
  protocols: ["Do53"],
  resolverEndpointType: "IPV4",
  tags: [{ key: "Name", value: "cdkrd-hunt-outbound" }],
});

const rule = new CfnResolverRule(stack, "HuntForwardRule", {
  name: "cdkrd-hunt-forward",
  ruleType: "FORWARD",
  domainName: "cdkrd-hunt.internal",
  resolverEndpointId: endpoint.attrResolverEndpointId,
  targetIps: [
    { ip: "10.0.0.54", port: "53" },
    { ip: "10.0.0.53", port: "53" },
  ],
  tags: [{ key: "Name", value: "cdkrd-hunt-forward" }],
});

new CfnResolverRuleAssociation(stack, "HuntRuleAssoc", {
  name: "cdkrd-hunt-assoc",
  resolverRuleId: rule.attrResolverRuleId,
  vpcId: vpc.vpcId,
});

new CfnOutput(stack, "ResolverRuleId", { value: rule.attrResolverRuleId });

app.synth();

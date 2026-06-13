// cdk-real-drift corpus-harvest wave 9 (real AWS) — R93.
// VPC-dependent uncovered CFn types: a minimal single-AZ VPC (no NAT) carrying a
// NetworkAcl + NetworkAclEntry, an S3 gateway VPC endpoint, and an EFS file system
// with an access point. Same harvest invariants as the earlier waves.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AclCidr,
  AclTraffic,
  Action,
  GatewayVpcEndpointAwsService,
  NetworkAcl,
  SubnetType,
  TrafficDirection,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { FileSystem } from "aws-cdk-lib/aws-efs";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest9");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const nacl = new NetworkAcl(stack, "Nacl", { vpc });
nacl.addEntry("AllowHttps", {
  cidr: AclCidr.anyIpv4(),
  traffic: AclTraffic.tcpPort(443),
  direction: TrafficDirection.INGRESS,
  ruleNumber: 100,
  ruleAction: Action.ALLOW,
});

vpc.addGatewayEndpoint("S3Endpoint", { service: GatewayVpcEndpointAwsService.S3 });

const fs = new FileSystem(stack, "Fs", { vpc, removalPolicy: RemovalPolicy.DESTROY });
fs.addAccessPoint("Ap", { path: "/cdkrd" });

app.synth();

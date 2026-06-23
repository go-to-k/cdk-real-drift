// CDK app for the cdk-real-drift eni-multiip-rich integration test.
// Follow-up to the eni-rich hunt (#349): that fixture had a SINGLE private IP, so
// the `PrivateIpAddresses` object-array was length 1 and the set-reorder path was
// never exercised. An ENI with MULTIPLE secondary IPs declares
// `PrivateIpAddresses` as a multi-element object array keyed by `PrivateIpAddress`
// (NOT an IDENTITY_FIELD, NOT id-shaped scalars) — an UNGUARDED object-array-set:
// AWS may echo the set in its own (sorted) order, so a positional diff false-flags
// every shifted element on a freshly recorded ENI. We declare the secondaries in a
// deliberately NON-sorted order to provoke it; a clean record→check must be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnNetworkInterface, IpAddresses, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEniMultiipRich");

const vpc = new Vpc(stack, "Vpc", {
  ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
  natGateways: 0,
  maxAzs: 1,
  subnetConfiguration: [{ name: "pub", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

// The first subnet is 10.0.0.0/24 (AWS reserves .1-.3 and .255). Declare a primary
// plus three secondaries in a NON-sorted order so an AWS canonical re-sort surfaces.
new CfnNetworkInterface(stack, "Eni", {
  subnetId: vpc.publicSubnets[0]!.subnetId,
  description: "cdkrd integ multi-ip network interface",
  privateIpAddresses: [
    { privateIpAddress: "10.0.0.10", primary: true },
    { privateIpAddress: "10.0.0.200", primary: false },
    { privateIpAddress: "10.0.0.50", primary: false },
    { privateIpAddress: "10.0.0.150", primary: false },
  ],
});

app.synth();

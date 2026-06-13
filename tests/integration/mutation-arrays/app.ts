// CDK app for the cdk-real-drift array/policy MUTATION integration test (R94).
//
// The highest-yield false-negative hunt: every property here is one whose
// normalizer SORTS or CANONICALIZES an array/policy (the exact class where the R88
// bugs lived). verify.sh adds an element out of band and asserts `check` DETECTS it
// — proving the normalization does not OVER-suppress and silently hide a real
// change. An IAM inline policy (policy canonicalization), a SecurityGroup ingress
// set (R88 object-array sort), and a WAFv2 IPSet address set (R84 scalar-set).
import { App, Stack } from "aws-cdk-lib";
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnIPSet } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMutationArrays");

// IAM role with a named inline policy (one action) -> verify.sh adds a second.
new Role(stack, "Role", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  inlinePolicies: {
    P: new PolicyDocument({
      statements: [
        new PolicyStatement({ effect: Effect.ALLOW, actions: ["s3:GetObject"], resources: ["*"] }),
      ],
    }),
  },
});

// SecurityGroup with two ingress rules -> verify.sh adds a third.
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const sg = new SecurityGroup(stack, "Sg", { vpc, allowAllOutbound: true });
sg.addIngressRule(Peer.ipv4("10.0.0.0/24"), Port.tcp(443), "https a");
sg.addIngressRule(Peer.ipv4("10.0.1.0/24"), Port.tcp(443), "https b");

// WAFv2 IPSet with two addresses -> verify.sh adds a third.
new CfnIPSet(stack, "IpSet", {
  name: "cdkrd-integ-mut-ipset",
  scope: "REGIONAL",
  ipAddressVersion: "IPV4",
  addresses: ["192.0.2.0/24", "198.51.100.0/24"],
});

app.synth();

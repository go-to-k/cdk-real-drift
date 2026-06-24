// CDK app for the cdk-real-drift glue-connection-readgap integration test.
//
// AWS::Glue::Connection is a CC read gap (NON_PROVISIONABLE — GetResource throws
// UnsupportedActionException), so the connection was silently `skipped` and an out-of-band
// change to its network/JDBC settings (ConnectionType, PhysicalConnectionRequirements,
// Description) was INVISIBLE — a security-relevant false negative on a common ETL
// data-source resource. The new SDK_OVERRIDES reader (Glue GetConnection, HidePassword)
// closes it. A NETWORK connection is used on purpose: it carries NO credentials (just a
// VPC subnet + security group), so the read is FP-clean with no secret ever touching the
// baseline. Cheap: a minimal isolated-subnet VPC (no NAT) + the connection.
import { App, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnConnection } from "aws-cdk-lib/aws-glue";

const app = new App();
// Env-bound so the VPC's AvailabilityZones resolve to CONCRETE names at synth (a
// production CDK pattern). NETWORK connections REQUIRE AvailabilityZone, and an
// env-agnostic stack would resolve it to an unresolvable Fn::GetAZs token that poisons
// the whole ConnectionInput comparison.
const stack = new Stack(app, "CdkRealDriftIntegGlueConnectionReadgap", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});
const sg = new SecurityGroup(stack, "Sg", { vpc });
const subnet = vpc.isolatedSubnets[0]!;

new CfnConnection(stack, "Conn", {
  catalogId: stack.account,
  connectionInput: {
    name: "cdkrd-network-conn",
    connectionType: "NETWORK",
    description: "cdkrd glue connection read-gap probe",
    physicalConnectionRequirements: {
      subnetId: subnet.subnetId,
      securityGroupIdList: [sg.securityGroupId],
      // concrete (env-bound stack) — resolves cleanly so ConnectionInput is comparable
      availabilityZone: subnet.availabilityZone,
    },
  },
});

app.synth();

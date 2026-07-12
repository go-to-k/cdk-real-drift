// Barest-config DAX fixture for the cdk-real-drift FP hunt: DAX::Cluster,
// DAX::ParameterGroup, and DAX::SubnetGroup all have SDK_OVERRIDES readers
// (Cloud Control NON_PROVISIONABLE / no read handler) that were added without
// ever being exercised against a live deploy — this deploys the MINIMAL
// required config of each so the first `check` (before `record`) exposes any
// first-run undeclared-default FPs and reader identifier-shape bugs.
// A raw CfnVPC + one CfnSubnet keeps the fixture minimal (no NAT, no IGW).
import { App, Fn, Stack, Tags } from "aws-cdk-lib";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnCluster, CfnParameterGroup, CfnSubnetGroup } from "aws-cdk-lib/aws-dax";
import { CfnRole } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntDax0712c");

const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.0.0.0/24" });
const subnet = new CfnSubnet(stack, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.0.0/24",
  availabilityZone: Fn.select(0, Fn.getAzs()),
});

const role = new CfnRole(stack, "DaxRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "dax.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
  policies: [
    {
      policyName: "dyn",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "dynamodb:*", Resource: "*" }],
      },
    },
  ],
});

const subnetGroup = new CfnSubnetGroup(stack, "SubnetGroup", {
  description: "cdkrd hunt",
  subnetIds: [subnet.ref],
});

// Barest parameter group: description only (no parameter overrides).
new CfnParameterGroup(stack, "ParamGroup", {
  description: "cdkrd hunt",
});

// Barest cluster: only what CFn requires (+ our subnet group so it does not
// demand a default VPC). Everything else is left undeclared on purpose.
new CfnCluster(stack, "Cluster", {
  iamRoleArn: role.attrArn,
  nodeType: "dax.t3.small",
  replicationFactor: 1,
  subnetGroupName: subnetGroup.ref,
});

app.synth();

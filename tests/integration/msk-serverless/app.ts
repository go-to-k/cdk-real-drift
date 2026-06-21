// CDK app for the cdk-real-drift MSK Serverless CC-support probe. MSK Serverless
// (AWS::MSK::ServerlessCluster) deploys fast (~3 min, no broker billing). Goal: measure
// whether Cloud Control can READ it (hunt-target) or throws UnsupportedAction (an
// SDK_OVERRIDE candidate, like the DB/service-discovery CC-gap tail).
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnServerlessCluster } from "aws-cdk-lib/aws-msk";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMskServerless");
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});
const subnetIds = vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds;
new CfnServerlessCluster(stack, "Cluster", {
  clusterName: "cdkrd-msk-serverless",
  vpcConfigs: [{ subnetIds, securityGroups: [vpc.vpcDefaultSecurityGroup] }],
  clientAuthentication: { sasl: { iam: { enabled: true } } },
});
app.synth();

// CDK app for the cdk-real-drift dbproxy-rich integration test.
// AWS::RDS::DBProxy is the standard connection-pooling front door for any
// serverless-on-RDS / Aurora + Lambda workload, deployed daily, with NO golden-
// corpus coverage yet (the RDS family covers DBCluster/DBInstance/param groups but
// not the proxy). It is FULLY_MUTABLE with a single-segment CC primaryIdentifier
// (DBProxyName), so it reads cleanly. A freshly recorded proxy MUST check CLEAN
// (the false-positive half — Auth[] is an object array, EngineFamily a case-enum),
// and `IdleClientTimeout` is a declared MUTABLE scalar (the false-negative target).
// The proxy needs a secret + an assume-role + >=2 subnets in different AZs; no DB
// instance/target is required, so the deploy is moderate (no stateful provisioning).
import { App, Stack } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDBProxy } from "aws-cdk-lib/aws-rds";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDbproxyRich");

const vpc = new Vpc(stack, "Vpc", {
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [{ name: "pub", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const sg = new SecurityGroup(stack, "Sg", { vpc });

const secret = new Secret(stack, "DbSecret", {
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: "admin" }),
    generateStringKey: "password",
    excludePunctuation: true,
  },
});

const role = new Role(stack, "ProxyRole", {
  assumedBy: new ServicePrincipal("rds.amazonaws.com"),
});
secret.grantRead(role);

new CfnDBProxy(stack, "Proxy", {
  dbProxyName: "cdkrd-integ-proxy",
  engineFamily: "POSTGRESQL",
  auth: [{ authScheme: "SECRETS", secretArn: secret.secretArn, iamAuth: "DISABLED" }],
  roleArn: role.roleArn,
  vpcSubnetIds: vpc.publicSubnets.map((s) => s.subnetId),
  vpcSecurityGroupIds: [sg.securityGroupId],
  requireTls: true,
  // Declared MUTABLE scalar — the false-negative target (change out of band).
  idleClientTimeout: 1800,
  debugLogging: false,
});

app.synth();

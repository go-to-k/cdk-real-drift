// cdk-real-drift corpus-harvest wave 12 (real AWS) — R127.
// Uncovered types weighted toward Map-shaped Parameters (stringly-in-a-map FP class)
// and config-dense fleet/networking config — none of the slow data-plane resources
// (no DB instance / cache cluster / Redshift cluster, only their fast parameter +
// subnet groups):
//   RDS DBParameterGroup + DBSubnetGroup, ElastiCache ParameterGroup + SubnetGroup,
//   Redshift ClusterParameterGroup + ClusterSubnetGroup, EC2 DHCPOptions +
//   CustomerGateway + VPNGateway, AutoScaling AutoScalingGroup (desiredCapacity 0 —
//   no instances launched). Each carries a few NON-default declared properties.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AutoScalingGroup,
  HealthChecks,
  TerminationPolicy,
} from "aws-cdk-lib/aws-autoscaling";
import {
  CfnCustomerGateway,
  CfnDHCPOptions,
  InstanceClass,
  InstanceSize,
  InstanceType,
  LaunchTemplate,
  MachineImage,
  SubnetType,
  VpnGateway,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  CfnParameterGroup as CfnCacheParameterGroup,
  CfnSubnetGroup as CfnCacheSubnetGroup,
} from "aws-cdk-lib/aws-elasticache";
import {
  CfnClusterParameterGroup,
  CfnClusterSubnetGroup,
} from "aws-cdk-lib/aws-redshift";
import { CfnDBParameterGroup, SubnetGroup as RdsSubnetGroup } from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest12");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});
const subnetIds = vpc.publicSubnets.map((s) => s.subnetId);

// --- RDS DBParameterGroup (Parameters Map<String,String> — stringly FP class) ---
// L1: the L2 rds.ParameterGroup is lazy (synthesizes nothing until bound to a DB).
new CfnDBParameterGroup(stack, "RdsParameterGroup", {
  family: "mysql8.0",
  description: "cdkrd harvest rds parameter group",
  dbParameterGroupName: "cdkrd-rds-pg",
  parameters: {
    general_log: "1",
    slow_query_log: "1",
    long_query_time: "2",
  },
});

// --- RDS DBSubnetGroup ---
new RdsSubnetGroup(stack, "RdsSubnetGroup", {
  description: "cdkrd harvest rds subnet group",
  vpc,
  subnetGroupName: "cdkrd-rds-subnet-group",
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
});

// --- ElastiCache ParameterGroup (Properties Map) + SubnetGroup ---
new CfnCacheParameterGroup(stack, "CacheParameterGroup", {
  cacheParameterGroupFamily: "redis7",
  description: "cdkrd harvest cache parameter group",
  properties: { "maxmemory-policy": "allkeys-lru" },
});
new CfnCacheSubnetGroup(stack, "CacheSubnetGroup", {
  description: "cdkrd harvest cache subnet group",
  subnetIds,
  cacheSubnetGroupName: "cdkrd-cache-subnet-group",
});

// --- Redshift ClusterParameterGroup (Parameters {ParameterName,ParameterValue}[]) + SubnetGroup ---
new CfnClusterParameterGroup(stack, "RedshiftParameterGroup", {
  parameterGroupFamily: "redshift-1.0",
  description: "cdkrd harvest redshift parameter group",
  parameters: [
    { parameterName: "enable_user_activity_logging", parameterValue: "true" },
    { parameterName: "require_ssl", parameterValue: "true" },
  ],
});
new CfnClusterSubnetGroup(stack, "RedshiftSubnetGroup", {
  description: "cdkrd harvest redshift subnet group",
  subnetIds,
});

// --- EC2 DHCPOptions (scalar + array config) ---
new CfnDHCPOptions(stack, "DhcpOptions", {
  domainName: "cdkrd.internal",
  domainNameServers: ["10.0.0.2"],
  ntpServers: ["169.254.169.123"],
});

// --- EC2 CustomerGateway + VPNGateway (cheap networking config) ---
new CfnCustomerGateway(stack, "CustomerGateway", {
  bgpAsn: 65000,
  ipAddress: "203.0.113.1",
  type: "ipsec.1",
});
new VpnGateway(stack, "VpnGateway", { type: "ipsec.1", amazonSideAsn: 64512 });

// --- AutoScaling AutoScalingGroup (config-dense; desiredCapacity 0 -> no instances) ---
const launchTemplate = new LaunchTemplate(stack, "LaunchTemplate", {
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
  machineImage: MachineImage.latestAmazonLinux2023(),
});
new AutoScalingGroup(stack, "AutoScalingGroup", {
  vpc,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  launchTemplate,
  autoScalingGroupName: "cdkrd-asg",
  minCapacity: 0,
  maxCapacity: 2,
  desiredCapacity: 0,
  healthChecks: HealthChecks.ec2(),
  terminationPolicies: [TerminationPolicy.OLDEST_INSTANCE, TerminationPolicy.DEFAULT],
  newInstancesProtectedFromScaleIn: false,
});

app.synth();

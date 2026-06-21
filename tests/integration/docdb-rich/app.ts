// CDK app for the cdk-real-drift docdb-rich false-positive + detect integration test.
// Amazon DocumentDB (AWS::DocDB::DBCluster + ::DBInstance) is a Cloud Control read
// gap — GetResource throws UnsupportedActionException for the whole DocDB family, so
// before the DescribeDBClusters / DescribeDBInstances SDK overrides the cluster + its
// props were `skipped` (invisible to drift detection). The cluster's BackupRetentionPeriod
// is the declared MUTABLE detect/revert subject. A small isolated VPC (no NAT) keeps
// the stack self-contained and cheap.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { InstanceClass, InstanceSize, InstanceType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { DatabaseCluster } from "aws-cdk-lib/aws-docdb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDocdbRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

new DatabaseCluster(stack, "Cluster", {
  masterUser: { username: "cdkrduser" },
  instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
  instances: 1,
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  backup: { retention: Duration.days(3) },
  removalPolicy: RemovalPolicy.DESTROY,
});

app.synth();

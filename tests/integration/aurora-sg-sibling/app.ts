// CDK app for the cdk-real-drift Aurora SecurityGroup-sibling false-positive integration
// test. The canonical CDK shape `cluster.connections.allowFrom(peer, Port.tcp(
// cluster.clusterEndpoint.port))` references the cluster's OWN endpoint port (a deploy-time
// GetAtt token) inside an ingress rule on the cluster's SG — a self-dependency CDK breaks by
// emitting the rule as a STANDALONE `AWS::EC2::SecurityGroupIngress` resource whose
// FromPort/ToPort are `Fn::GetAtt <Cluster>.Endpoint.Port` (the "{IndirectPort}" shape).
//
// The SG reflects that sibling rule into its live `SecurityGroupIngress` array with a NUMBER
// port (3306), while the sibling's declared port resolves against the DBCluster's live model,
// where Endpoint.Port is a STRING ("3306"). The strict deepEqual sibling-subtract then failed
// on the typed<->string mismatch, so the DECLARED ingress rule false-flagged as UNDECLARED
// potential drift on every CDK Aurora stack. This fixture is the real-AWS regression guard.
//
// A single writer instance on a small isolated VPC (no NAT) keeps the stack self-contained.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  AuroraMysqlEngineVersion,
  ClusterInstance,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAuroraSgSibling");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const engine = DatabaseClusterEngine.auroraMysql({
  version: AuroraMysqlEngineVersion.of("8.0.mysql_aurora.3.10.4", "8.0"),
});

const cluster = new DatabaseCluster(stack, "Cluster", {
  engine,
  writer: ClusterInstance.provisioned("writer", {
    instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
  }),
  vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  removalPolicy: RemovalPolicy.DESTROY,
});

// The load-bearing line: the port is the cluster's OWN endpoint port token, so CDK emits a
// standalone SecurityGroupIngress whose FromPort/ToPort are GetAtt <Cluster>.Endpoint.Port.
cluster.connections.allowFrom(
  Peer.ipv4("192.168.0.0/16"),
  Port.tcp(cluster.clusterEndpoint.port),
  "from 192.168.0.0/16"
);

app.synth();

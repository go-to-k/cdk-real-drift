// CDK app for the cdk-real-drift elb-classic-rich integration test. Classic
// ElasticLoadBalancing::LoadBalancer (CLB) is read NATIVELY via Cloud Control
// (full CRUD handlers, single-segment primaryIdentifier LoadBalancerName). Classic
// ELB is a heavy default-filler: on create AWS materializes ConnectionSettings
// (IdleTimeout 60), ConnectionDrainingPolicy (disabled), a HealthCheck bag,
// Policies, CrossZone, Scheme, and an auto SecurityGroup — none of which the
// template declares. Per the core invariant a clean deploy of this stack must
// produce ZERO [Potential Drift] on a first `check` before `record`: every
// AWS-assigned initial must fold to atDefault. This fixture is the FP oracle for
// that. Internal (internetFacing:false) CLB in isolated subnets keeps it
// self-contained and cheap (no NAT, no data path).
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  LoadBalancer,
  LoadBalancingProtocol,
} from "aws-cdk-lib/aws-elasticloadbalancing";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbClassicRich");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

// Declare only a health check + one listener. Everything else (ConnectionSettings,
// ConnectionDrainingPolicy, CrossZone, Policies, Scheme, SecurityGroups) is left to
// AWS so the first `check` surfaces its undeclared fills — the FP hunting ground.
const lb = new LoadBalancer(stack, "Clb", {
  vpc,
  internetFacing: false,
  subnetSelection: { subnetType: SubnetType.PRIVATE_ISOLATED },
  healthCheck: {
    port: 80,
    path: "/",
    protocol: LoadBalancingProtocol.HTTP,
    interval: undefined,
    timeout: undefined,
    healthyThreshold: undefined,
    unhealthyThreshold: undefined,
  },
});

lb.addListener({
  externalPort: 80,
  externalProtocol: LoadBalancingProtocol.HTTP,
  internalPort: 80,
  internalProtocol: LoadBalancingProtocol.HTTP,
});

app.synth();

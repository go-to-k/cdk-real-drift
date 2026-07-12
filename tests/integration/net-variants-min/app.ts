// CDK app for the cdk-real-drift net-variants-min false-positive integration test.
// Uncovered ELBv2 / MSK VARIANT axes (the corpus covers only application/network
// LBs, instance/ip/lambda target groups, and provisioned MSK):
// - AWS::ElasticLoadBalancingV2::LoadBalancer Type=gateway (GWLB)
// - AWS::ElasticLoadBalancingV2::TargetGroup Protocol=GENEVE (the GWLB TG shape)
// - AWS::ElasticLoadBalancingV2::TargetGroup TargetType=alb (ALB behind an NLB)
// - AWS::MSK::ServerlessCluster (a distinct CFn type from AWS::MSK::Cluster)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnLoadBalancer, CfnListener, CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnServerlessCluster } from "aws-cdk-lib/aws-msk";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713bNetVariants");

const vpc = new Vpc(stack, "HuntVpc", { maxAzs: 2, natGateways: 0 });
const publicSubnetIds = vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds;

// -- GWLB + GENEVE target group --
const gwlb = new CfnLoadBalancer(stack, "HuntGwlb", {
  type: "gateway",
  subnets: publicSubnetIds,
});
const geneveTg = new CfnTargetGroup(stack, "HuntGeneveTg", {
  protocol: "GENEVE",
  port: 6081,
  vpcId: vpc.vpcId,
  targetType: "ip",
  healthCheckProtocol: "TCP",
  healthCheckPort: "80",
});
new CfnListener(stack, "HuntGwlbListener", {
  loadBalancerArn: gwlb.ref,
  defaultActions: [{ type: "forward", targetGroupArn: geneveTg.ref }],
});

// -- ALB as a target of an NLB (TargetType=alb) --
const alb = new CfnLoadBalancer(stack, "HuntAlb", {
  type: "application",
  scheme: "internal",
  subnets: publicSubnetIds,
});
const albTg = new CfnTargetGroup(stack, "HuntAlbTg", {
  protocol: "TCP",
  port: 80,
  vpcId: vpc.vpcId,
  targetType: "alb",
  targets: [{ id: alb.ref, port: 80 }],
});
const albListener = new CfnListener(stack, "HuntAlbListener", {
  loadBalancerArn: alb.ref,
  protocol: "HTTP",
  port: 80,
  defaultActions: [{ type: "fixed-response", fixedResponseConfig: { statusCode: "200" } }],
});
const nlb = new CfnLoadBalancer(stack, "HuntNlb", {
  type: "network",
  scheme: "internal",
  subnets: publicSubnetIds,
});
const nlbListener = new CfnListener(stack, "HuntNlbListener", {
  loadBalancerArn: nlb.ref,
  protocol: "TCP",
  port: 80,
  defaultActions: [{ type: "forward", targetGroupArn: albTg.ref }],
});
nlbListener.addDependency(albListener);

// -- MSK Serverless --
const mskSg = new SecurityGroup(stack, "HuntMskSg", { vpc, allowAllOutbound: true });
new CfnServerlessCluster(stack, "HuntMskServerless", {
  clusterName: "cdkrd-hunt-msk-serverless",
  clientAuthentication: { sasl: { iam: { enabled: true } } },
  vpcConfigs: [
    {
      subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
      securityGroups: [mskSg.securityGroupId],
    },
  ],
});

// CDK app for the cdk-real-drift IoT Core + VPC endpoint service false-positive
// and missed-detection test. IoT has ZERO corpus coverage despite being a very
// common device-fleet stack; the PrivateLink provider side is also uncovered:
// - AWS::IoT::Thing (attribute payload), AWS::IoT::Policy (policy document),
//   AWS::IoT::TopicRule (SQL + CloudWatch Logs action) — the TopicRule also
//   drives the FN half: verify.sh disables the rule out of band and asserts
//   check detects the declared RuleDisabled drift, then reverts it.
// - AWS::EC2::VPCEndpointService fronting an internal NLB (PrivateLink provider).
// A freshly deployed + recorded stack with NO out-of-band change MUST report
// CLEAN; any drift here is a normalization / default-folding FP.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnVPCEndpointService, IpAddresses, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { NetworkLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnPolicy, CfnThing, CfnTopicRule } from "aws-cdk-lib/aws-iot";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegIotVpces");

new CfnThing(stack, "Thing", {
  thingName: "cdkrd-hunt-thing",
  attributePayload: {
    attributes: { env: "hunt", owner: "cdkrd" },
  },
});

new CfnPolicy(stack, "DevicePolicy", {
  policyName: "cdkrd-hunt-iot-policy",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["iot:Connect"],
        Resource: [`arn:aws:iot:${stack.region}:${stack.account}:client/cdkrd-hunt-*`],
      },
      {
        Effect: "Allow",
        Action: ["iot:Publish"],
        Resource: [`arn:aws:iot:${stack.region}:${stack.account}:topic/cdkrd/hunt/*`],
      },
    ],
  },
});

const ruleLogs = new LogGroup(stack, "RuleLogs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

const ruleRole = new Role(stack, "RuleRole", {
  assumedBy: new ServicePrincipal("iot.amazonaws.com"),
});
ruleRole.addToPolicy(
  new PolicyStatement({
    actions: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
    resources: [ruleLogs.logGroupArn],
  }),
);

new CfnTopicRule(stack, "Rule", {
  ruleName: "cdkrd_hunt_rule",
  topicRulePayload: {
    sql: "SELECT temperature, deviceId FROM 'cdkrd/hunt/telemetry' WHERE temperature > 20",
    awsIotSqlVersion: "2016-03-23",
    ruleDisabled: false,
    description: "cdkrd hunt fixture rule (FN target: RuleDisabled)",
    actions: [
      {
        cloudwatchLogs: {
          logGroupName: ruleLogs.logGroupName,
          roleArn: ruleRole.roleArn,
        },
      },
    ],
  },
});

// PrivateLink provider side: internal NLB + VPC endpoint service.
const vpc = new Vpc(stack, "Vpc", {
  ipAddresses: IpAddresses.cidr("10.61.0.0/24"),
  natGateways: 0,
  maxAzs: 2,
  subnetConfiguration: [
    { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 26 },
  ],
});

const nlb = new NetworkLoadBalancer(stack, "Nlb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
});

new CfnVPCEndpointService(stack, "EndpointService", {
  networkLoadBalancerArns: [nlb.loadBalancerArn],
  acceptanceRequired: true,
  supportedIpAddressTypes: ["ipv4"],
});

app.synth();

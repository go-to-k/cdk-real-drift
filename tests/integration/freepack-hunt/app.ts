// Barest-variant first-run FP probe (2026-08-01 hunt) — the free/near-free pack
// from the coverage audit:
// - ASG MixedInstancesPolicy union branch (every existing ASG fixture uses the
//   flat LaunchTemplate branch; MIP's InstancesDistribution defaults are the
//   probe surface). Min/Max/Desired 0 → zero instances → free.
// - ELBv2 TargetGroup protocol×target-type CROSS products never deployed:
//   GENEVE×instance, TLS×ip (per-axis rows exist; the intersections do not, the
//   #1664/#1683 class), plus the never-deployed HTTPS protocol barest.
// - EC2 Volume with NO KNOWN_DEFAULTS entry at all: barest (Size-only → gp2
//   echoes) and gp3-declared (Iops 3000 / Throughput 125 echoes).
// - Route53 HealthCheck with RequestInterval/FailureThreshold UNDECLARED (all 3
//   corpus cases declare exactly the two folded values) + a TCP-type check.
// - Events Connection BASIC auth branch (only API_KEY ever deployed; no
//   KNOWN_DEFAULTS entry for the type).
// - SNS Subscription lambda protocol (all 4 corpus cases are sqs).
import { App, CfnResource, Duration, Stack, Tags } from "aws-cdk-lib";
import {
  CfnLaunchTemplate,
  CfnSubnet,
  CfnVPC,
  CfnVolume,
} from "aws-cdk-lib/aws-ec2";
import { CfnAutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import { CfnTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnHealthCheck } from "aws-cdk-lib/aws-route53";
import { CfnConnection } from "aws-cdk-lib/aws-events";
import { CfnSubscription, CfnTopic } from "aws-cdk-lib/aws-sns";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");

// ---------- Stack A: VPC-scoped free probes ----------
const a = new Stack(app, "CdkrdHunt0801FreeA");
const vpc = new CfnVPC(a, "Vpc", { cidrBlock: "10.64.0.0/16" });
const subnet = new CfnSubnet(a, "Subnet", {
  vpcId: vpc.ref,
  cidrBlock: "10.64.0.0/24",
  availabilityZone: "us-east-1a",
});

// Barest MixedInstancesPolicy ASG: only the LaunchTemplate spec + one override
// declared — InstancesDistribution and its five defaults are the probe surface.
const lt = new CfnLaunchTemplate(a, "Lt", {
  launchTemplateData: {
    instanceType: "t3.micro",
    imageId:
      "{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}",
  },
});
new CfnAutoScalingGroup(a, "MipAsg", {
  minSize: "0",
  maxSize: "0",
  desiredCapacity: "0",
  vpcZoneIdentifier: [subnet.ref],
  mixedInstancesPolicy: {
    launchTemplate: {
      launchTemplateSpecification: {
        launchTemplateId: lt.ref,
        version: lt.attrLatestVersionNumber,
      },
      overrides: [{ instanceType: "t3.micro" }],
    },
  },
});

// Never-deployed protocol×target-type crosses + the HTTPS protocol barest.
new CfnTargetGroup(a, "GeneveInstTg", {
  protocol: "GENEVE",
  port: 6081,
  targetType: "instance",
  vpcId: vpc.ref,
});
new CfnTargetGroup(a, "TlsIpTg", {
  protocol: "TLS",
  port: 443,
  targetType: "ip",
  vpcId: vpc.ref,
});
new CfnTargetGroup(a, "HttpsTg", {
  protocol: "HTTPS",
  port: 443,
  vpcId: vpc.ref,
});

// EC2 Volume: barest (Size only → VolumeType gp2 echo?) and gp3-declared
// (Iops/Throughput echoes).
new CfnVolume(a, "BarestVol", {
  availabilityZone: "us-east-1a",
  size: 10,
});
new CfnVolume(a, "Gp3Vol0801", {
  availabilityZone: "us-east-1a",
  size: 10,
  volumeType: "gp3",
});

// ---------- Stack B: global/API free probes ----------
const b = new Stack(app, "CdkrdHunt0801FreeB");

// Barest HTTP health check: Type + FQDN only — RequestInterval/FailureThreshold/
// Port/MeasureLatency/Inverted/Disabled all undeclared.
new CfnHealthCheck(b, "HttpHc", {
  healthCheckConfig: {
    type: "HTTP",
    fullyQualifiedDomainName: "example.com",
  },
});
// TCP-type check (never deployed; EnableSNI fold must NOT mis-apply here).
new CfnHealthCheck(b, "TcpHc", {
  healthCheckConfig: {
    type: "TCP",
    fullyQualifiedDomainName: "example.com",
    port: 443,
  },
});

// Events Connection BASIC auth branch. The password is write-only; the probe is
// the AuthParameters echo shape (redaction husks) + any undeclared defaults.
new CfnConnection(b, "BasicConn", {
  authorizationType: "BASIC",
  authParameters: {
    basicAuthParameters: {
      username: "cdkrd-hunt",
      password: "Cdkrd-hunt-0801-probe!",
    },
  },
});

// SNS Subscription, lambda protocol (all corpus subscriptions are sqs).
const topic = new CfnTopic(b, "Topic0801");
const fn = new Function(b, "SubFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler=async()=>({});"),
  timeout: Duration.seconds(10),
});
new CfnSubscription(b, "LambdaSub", {
  protocol: "lambda",
  topicArn: topic.ref,
  endpoint: fn.functionArn,
});
new CfnResource(b, "SubPerm", {
  type: "AWS::Lambda::Permission",
  properties: {
    Action: "lambda:InvokeFunction",
    FunctionName: fn.functionName,
    Principal: "sns.amazonaws.com",
    SourceArn: topic.ref,
  },
});

app.synth();

// CDK app for the cdk-real-drift elb-attr FN integration test. ELBv2 LoadBalancer /
// TargetGroup attribute bags are read NATIVELY via Cloud Control; the R78 subset
// comparison only compares DECLARED attribute keys (extra live keys are dropped to
// stay FP-free on a fresh deploy). The audit flagged a trade-off: an out-of-band
// change to an UNDECLARED attribute may be a permanent FN. This fixture proves the
// behavior empirically — declare ONE attribute on the LB and ONE on the TG, then the
// verify script (a) changes a DECLARED attribute (must DETECT) and (b) changes an
// UNDECLARED attribute after `record` (does the recorded-undeclared dimension catch
// it?). Internal ALB in isolated subnets keeps the stack self-contained.
import { App, Stack } from "aws-cdk-lib";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElbAttr");

const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 2,
  natGateways: 0,
  subnetConfiguration: [{ name: "iso", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
});

const lb = new ApplicationLoadBalancer(stack, "Lb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  loadBalancerName: "cdkrd-elb-attr",
});
lb.setAttribute("idle_timeout.timeout_seconds", "120"); // DECLARED attribute

const tg = new ApplicationTargetGroup(stack, "Tg", {
  vpc,
  port: 80,
  protocol: ApplicationProtocol.HTTP,
  targetType: TargetType.IP,
  targetGroupName: "cdkrd-elb-attr-tg",
});
tg.setAttribute("deregistration_delay.timeout_seconds", "30"); // DECLARED attribute

lb.addListener("L", { port: 80, defaultTargetGroups: [tg] });

app.synth();

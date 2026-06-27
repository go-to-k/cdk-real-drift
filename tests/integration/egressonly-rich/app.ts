// CDK app for the cdk-real-drift egress-only internet gateway false-positive test.
// An EgressOnlyInternetGateway is the IPv6 equivalent of a NAT gateway, common on
// dual-stack VPCs. Cheap. A freshly deployed + recorded EOIGW with NO out-of-band
// change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnEgressOnlyInternetGateway, CfnVPC, CfnVPCCidrBlock } from "aws-cdk-lib/aws-ec2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEgressOnly");

const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.73.0.0/16" });
new CfnVPCCidrBlock(stack, "Ipv6", { vpcId: vpc.ref, amazonProvidedIpv6CidrBlock: true });

new CfnEgressOnlyInternetGateway(stack, "Eoigw", { vpcId: vpc.ref });

app.synth();

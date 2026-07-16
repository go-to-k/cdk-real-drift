// CloudFormation-notation live probes (real AWS) — the intrinsic-resolver audit
// found these user-common notations have unit tests but ZERO live end-to-end runs:
// - Fn::Cidr (+ Fn::Select over Fn::GetAtt): the IPv4 tiling math has never been
//   compared against a real subnet's live CidrBlock echo — a mis-tile is a declared
//   FP on CidrBlock.
// - Fn::GetAZs (+ Fn::Select): zero unit tests; must land in the unresolved tier
//   (fail-closed), never a declared FP.
// - {{resolve:ssm:...}} dynamic reference in a Lambda environment variable: the
//   declared value must stay unresolved (no declared FP against the live resolved
//   value), and no revert plan may ever write the literal token to AWS.
import { App, Fn, Stack, Tags } from "aws-cdk-lib";
import { CfnSubnet, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnParameter } from "aws-cdk-lib/aws-ssm";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0717Notation2");

const vpc = new CfnVPC(s, "Vpc", { cidrBlock: "10.61.0.0/16" });

// CidrBlock = Fn::Select(i, Fn::Cidr(Fn::GetAtt Vpc.CidrBlock, 4, 8)) — the raw
// token survives synth (attrCidrBlock is unresolvable locally).
new CfnSubnet(s, "SubA", {
  vpcId: vpc.ref,
  cidrBlock: Fn.select(0, Fn.cidr(vpc.attrCidrBlock, 4, "8")),
  availabilityZone: Fn.select(0, Fn.getAzs()),
});
new CfnSubnet(s, "SubB", {
  vpcId: vpc.ref,
  cidrBlock: Fn.select(2, Fn.cidr(vpc.attrCidrBlock, 4, "8")),
  availabilityZone: Fn.select(1, Fn.getAzs()),
});

// {{resolve:ssm:...}} dynamic reference probe.
const param = new CfnParameter(s, "Param", {
  type: "String",
  name: "cdkrd-hunt0717-notation-param",
  value: "hunt-value-1",
});

const role = new Role(s, "FnRole", {
  assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName(
      "service-role/AWSLambdaBasicExecutionRole"
    ),
  ],
});

const fn = new CfnFunction(s, "Fn", {
  functionName: "cdkrd-hunt0717-notation-fn",
  role: role.roleArn,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: { zipFile: "exports.handler = async () => ({ ok: true });" },
  environment: {
    variables: { SSM_VAL: `{{resolve:ssm:${param.ref}}}` },
  },
});
fn.addDependency(param);

// CDK app for the cdk-real-drift Lambda EventSourceMapping SourceAccessConfigurations
// false-positive test. A self-managed Apache Kafka event source (a common streaming
// integration) carries SourceAccessConfigurations: a SET of {Type, URI} entries
// (VPC_SUBNET x2, VPC_SECURITY_GROUP, SASL_SCRAM_512_AUTH) whose `Type` is NOT one of
// canonicalizeTagListsDeep's IDENTITY_FIELDS — so if Lambda echoes the set SORTED (not
// in template order) a positional compare would false-flag every shifted entry as
// declared drift. We declare the set NON-sorted on purpose to expose any reorder.
// A freshly deployed + recorded ESM with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnVPC, CfnSubnet, CfnSecurityGroup } from "aws-cdk-lib/aws-ec2";
import { CfnFunction, CfnEventSourceMapping } from "aws-cdk-lib/aws-lambda";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnSecret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEsmSourceaccessRich");

// Minimal VPC + two subnets + a security group — only their IDs are referenced by the
// ESM's VPC SourceAccessConfigurations; no IGW/NAT is needed for the mapping to create.
const vpc = new CfnVPC(stack, "Vpc", { cidrBlock: "10.0.0.0/16" });
const subnet1 = new CfnSubnet(stack, "Subnet1", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.0.0/24",
  availabilityZone: "us-east-1a",
});
const subnet2 = new CfnSubnet(stack, "Subnet2", {
  vpcId: vpc.ref,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-east-1b",
});
const sg = new CfnSecurityGroup(stack, "Sg", {
  groupDescription: "cdkrd esm kafka",
  vpcId: vpc.ref,
});

const secret = new CfnSecret(stack, "KafkaAuth", {
  name: "cdkrd-esm-kafka-auth",
  secretString: JSON.stringify({ username: "cdkrd", password: "cdkrd-placeholder" }),
});

const role = new CfnRole(stack, "FnRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  },
  managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
  policies: [
    {
      policyName: "esm",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ec2:CreateNetworkInterface",
              "ec2:DescribeNetworkInterfaces",
              "ec2:DeleteNetworkInterface",
              "ec2:DescribeVpcs",
              "ec2:DescribeSubnets",
              "ec2:DescribeSecurityGroups",
            ],
            Resource: "*",
          },
          { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secret.ref },
        ],
      },
    },
  ],
});

const fn = new CfnFunction(stack, "Fn", {
  functionName: "cdkrd-esm-consumer",
  runtime: "python3.12",
  handler: "index.handler",
  role: role.attrArn,
  code: { zipFile: "def handler(e, c):\n    return None\n" },
});

new CfnEventSourceMapping(stack, "Esm", {
  functionName: fn.ref,
  selfManagedEventSource: {
    endpoints: { kafkaBootstrapServers: ["b-1.cdkrd.example.com:9092", "b-2.cdkrd.example.com:9092"] },
  },
  topics: ["cdkrd-topic"],
  startingPosition: "TRIM_HORIZON",
  batchSize: 100,
  // Declared NON-sorted (VPC_SECURITY_GROUP first, SASL second, subnets last) so that
  // an alphabetical-by-Type reorder by Lambda (SASL_SCRAM_512_AUTH, VPC_SECURITY_GROUP,
  // VPC_SUBNET, VPC_SUBNET) would surface as a positional diff if cdkrd doesn't fold it.
  sourceAccessConfigurations: [
    { type: "VPC_SECURITY_GROUP", uri: `security_group:${sg.attrGroupId}` },
    { type: "SASL_SCRAM_512_AUTH", uri: secret.ref },
    { type: "VPC_SUBNET", uri: `subnet:${subnet1.ref}` },
    { type: "VPC_SUBNET", uri: `subnet:${subnet2.ref}` },
  ],
});

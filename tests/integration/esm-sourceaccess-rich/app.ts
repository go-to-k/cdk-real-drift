// CDK app for the cdk-real-drift Lambda EventSourceMapping reorder false-positive test.
// A self-managed Apache Kafka event source (a common streaming integration) carries
// SelfManagedEventSource.Endpoints.KafkaBootstrapServers — a SET of broker host:port
// strings whose order AWS may echo differently than the template. This reorder was the
// real FP folded in #437, and it is the PRIMARY target here: we declare the two brokers
// NON-sorted on purpose so an alphabetical reorder by Lambda surfaces as a positional diff
// if cdkrd doesn't fold it. A freshly deployed + recorded ESM with NO out-of-band change
// MUST report CLEAN.
//
// NOTE: this fixture deliberately does NOT attach the ESM to a VPC, and carries only a
// single SASL SourceAccessConfiguration. A VPC-attached self-managed-Kafka ESM leaves
// Lambda Hyperplane ENIs `in-use` for ~20-40 min after teardown, blocking subnet/SG/VPC
// deletion (CFn DELETE_FAILED) — see issue #441. The KafkaBootstrapServers reorder needs
// no VPC; the VPC_SUBNET/VPC_SECURITY_GROUP multi-element SourceAccessConfigurations
// order-PRESERVED rule-out is documented observed-only in the noise.ts comment and is not
// worth the teardown cost.
import { App, Stack } from "aws-cdk-lib";
import { CfnFunction, CfnEventSourceMapping } from "aws-cdk-lib/aws-lambda";
import { CfnRole } from "aws-cdk-lib/aws-iam";
import { CfnSecret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEsmSourceaccessRich");

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
    // Declared NON-sorted (b-2 before b-1) so an alphabetical-by-host reorder by Lambda
    // would surface as a positional diff if cdkrd doesn't fold it (the #437 FP).
    endpoints: { kafkaBootstrapServers: ["b-2.cdkrd.example.com:9092", "b-1.cdkrd.example.com:9092"] },
  },
  topics: ["cdkrd-topic"],
  startingPosition: "TRIM_HORIZON",
  batchSize: 100,
  sourceAccessConfigurations: [{ type: "SASL_SCRAM_512_AUTH", uri: secret.ref }],
});

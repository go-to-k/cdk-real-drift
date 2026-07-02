// CDK app for the cdk-real-drift misc0cov3-rich false-positive integration
// test. Grab-bag of zero-corpus-coverage, cheap, commonly-hit types:
// - AWS::EventSchemas::Discoverer — on a dedicated custom bus; CrossAccount
//   declared false (service default is true).
// - AWS::ApiGateway::ClientCertificate — description only (mutable FN target).
// - AWS::Glue::Registry + AWS::Glue::Schema — AVRO SchemaDefinition is a
//   JSON-string prop (whitespace/key-order canonicalization probe).
// - AWS::Logs::Destination — Kinesis target + role; DestinationPolicy is a
//   JSON-string policy (policy canonicalization probe).
// - AWS::CloudFront::RealtimeLogConfig — Fields declared in natural (NON
//   alphabetical) order as a list-order probe; SamplingRate number.
// - AWS::Bedrock::Prompt — TEXT variant with an input variable.
import { App, Stack } from "aws-cdk-lib";
import { CfnClientCertificate } from "aws-cdk-lib/aws-apigateway";
import { CfnPrompt } from "aws-cdk-lib/aws-bedrock";
import { CfnRealtimeLogConfig } from "aws-cdk-lib/aws-cloudfront";
import { CfnEventBus } from "aws-cdk-lib/aws-events";
import { CfnDiscoverer } from "aws-cdk-lib/aws-eventschemas";
import { CfnRegistry, CfnSchema } from "aws-cdk-lib/aws-glue";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import { CfnDestination } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMisc0Cov3");

const bus = new CfnEventBus(stack, "HuntDiscBus", {
  name: "cdkrd-hunt-disc-bus",
});

new CfnDiscoverer(stack, "HuntDiscoverer", {
  sourceArn: bus.attrArn,
  description: "cdkrd hunt schema discoverer",
  crossAccount: false,
});

new CfnClientCertificate(stack, "HuntClientCert", {
  description: "cdkrd hunt client certificate",
});

const registry = new CfnRegistry(stack, "HuntGlueRegistry", {
  name: "cdkrd-hunt-registry",
  description: "cdkrd hunt glue schema registry",
});

new CfnSchema(stack, "HuntGlueSchema", {
  name: "cdkrd-hunt-schema",
  registry: { arn: registry.attrArn },
  dataFormat: "AVRO",
  compatibility: "BACKWARD",
  schemaDefinition: JSON.stringify({
    type: "record",
    name: "HuntEvent",
    fields: [
      { name: "id", type: "string" },
      { name: "count", type: "int" },
    ],
  }),
});

const stream = new Stream(stack, "HuntStream", {
  streamName: "cdkrd-hunt-dest-stream",
  streamMode: StreamMode.PROVISIONED,
  shardCount: 1,
});

const logsDestRole = new Role(stack, "HuntLogsDestRole", {
  assumedBy: new ServicePrincipal("logs.amazonaws.com"),
});
logsDestRole.addToPolicy(
  new PolicyStatement({
    actions: ["kinesis:PutRecord"],
    resources: [stream.streamArn],
  }),
);

const logsDest = new CfnDestination(stack, "HuntLogsDestination", {
  destinationName: "cdkrd-hunt-dest",
  targetArn: stream.streamArn,
  roleArn: logsDestRole.roleArn,
  destinationPolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: stack.account },
        Action: "logs:PutSubscriptionFilter",
        Resource: `arn:aws:logs:${stack.region}:${stack.account}:destination:cdkrd-hunt-dest`,
      },
    ],
  }),
});

// The destination handler test-writes to Kinesis at create time; without an
// explicit dependency it races the role's DefaultPolicy attachment.
logsDest.node.addDependency(logsDestRole);

const rtlRole = new Role(stack, "HuntRtlRole", {
  assumedBy: new ServicePrincipal("cloudfront.amazonaws.com"),
});
rtlRole.addToPolicy(
  new PolicyStatement({
    actions: ["kinesis:DescribeStream", "kinesis:PutRecord", "kinesis:PutRecords"],
    resources: [stream.streamArn],
  }),
);

const rtl = new CfnRealtimeLogConfig(stack, "HuntRealtimeLogConfig", {
  name: "cdkrd-hunt-rtl",
  samplingRate: 5,
  fields: ["timestamp", "c-ip", "sc-status", "cs-method", "cs-uri-stem"],
  endPoints: [
    {
      streamType: "Kinesis",
      kinesisStreamConfig: {
        roleArn: rtlRole.roleArn,
        streamArn: stream.streamArn,
      },
    },
  ],
});

rtl.node.addDependency(rtlRole);

new CfnPrompt(stack, "HuntPrompt", {
  name: "cdkrd-hunt-prompt",
  description: "cdkrd hunt bedrock prompt",
  defaultVariant: "v1",
  variants: [
    {
      name: "v1",
      templateType: "TEXT",
      templateConfiguration: {
        text: {
          text: "Summarize the following topic: {{topic}}",
          inputVariables: [{ name: "topic" }],
        },
      },
    },
  ],
});

app.synth();

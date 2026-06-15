// cdk-real-drift corpus-harvest wave 10 (real AWS) — R125.
// Uncovered config-dense CFn types that are still cheap/fast to deploy:
//   CloudFront CachePolicy / OriginRequestPolicy / ResponseHeadersPolicy / Function /
//   PublicKey / KeyGroup, AppMesh Mesh + VirtualNode, Lambda LayerVersion +
//   EventInvokeConfig, Kinesis StreamConsumer, Logs SubscriptionFilter, ECS Service
//   (Fargate, desiredCount 0 — no steady-state wait), ServiceDiscovery
//   PrivateDnsNamespace + Service. Each carries a few NON-default declared properties
//   so a declared-side normalization FP would surface as drift on a fresh deploy.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CachePolicy,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  Function as CfFunction,
  FunctionCode,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  KeyGroup,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  PublicKey,
  ResponseHeadersPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import {
  HealthCheck,
  Mesh,
  MeshFilterType,
  ServiceDiscovery as AppMeshServiceDiscovery,
  VirtualNode,
  VirtualNodeListener,
} from "aws-cdk-lib/aws-appmesh";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import { Code, Function as LambdaFunction, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { Stream, StreamConsumer } from "aws-cdk-lib/aws-kinesis";
import { FilterPattern, LogGroup, RetentionDays, SubscriptionFilter } from "aws-cdk-lib/aws-logs";
import { LambdaDestination } from "aws-cdk-lib/aws-logs-destinations";
import { DnsRecordType, PrivateDnsNamespace } from "aws-cdk-lib/aws-servicediscovery";

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmV2B6CPA7I84sYHT3A8D
BQj2+c6N49hA1OJ3eTxkVEcLtMJ+583sKoz9Zy5DQk74UVsTMWBy+fZVbvZkNrjo
SEuLkk25bohGAFOLNTZBhbkBmhxo1+LpIIRmuIwNJA+/GCfWqqEMOvPMhxuYxgrr
NUCoNn7ITqQezIiQMRe9byqnZuQWlFq4lRJ4HSfmvmToPXRbDeSMrOIn4YbbKZfL
A3DjHu/xI100aCUjuTVLhxS00JrDVtno/8hMX6+MgwZtT8Z9aJUXYpEMIWzAQQr6
DXDxWn8W86XPBkN+rZu4O9Fpc8Om7n3VV0yxS2U5+qvgAysxXb8eUL5dwxZRe+PG
DQIDAQAB
-----END PUBLIC KEY-----`;

const app = new App();
const stack = new Stack(app, "CdkdriftIntegHarvest10");

// --- CloudFront policies + function + signing keys (no infra, deploy in seconds) ---
new CachePolicy(stack, "CachePolicy", {
  cachePolicyName: "cdkrd-cache",
  comment: "cdkrd harvest cache policy",
  defaultTtl: Duration.hours(1),
  minTtl: Duration.minutes(1),
  maxTtl: Duration.days(1),
  cookieBehavior: CacheCookieBehavior.allowList("session"),
  headerBehavior: CacheHeaderBehavior.allowList("Authorization"),
  queryStringBehavior: CacheQueryStringBehavior.allowList("q"),
  enableAcceptEncodingGzip: true,
  enableAcceptEncodingBrotli: true,
});

new OriginRequestPolicy(stack, "OriginRequestPolicy", {
  originRequestPolicyName: "cdkrd-origin-req",
  comment: "cdkrd harvest origin request policy",
  cookieBehavior: OriginRequestCookieBehavior.all(),
  headerBehavior: OriginRequestHeaderBehavior.allowList("CloudFront-Viewer-Country"),
  queryStringBehavior: OriginRequestQueryStringBehavior.all(),
});

new ResponseHeadersPolicy(stack, "ResponseHeadersPolicy", {
  responseHeadersPolicyName: "cdkrd-resp",
  comment: "cdkrd harvest response headers policy",
  corsBehavior: {
    accessControlAllowCredentials: false,
    accessControlAllowHeaders: ["*"],
    accessControlAllowMethods: ["GET", "POST"],
    accessControlAllowOrigins: ["https://example.com"],
    accessControlExposeHeaders: ["*"],
    accessControlMaxAge: Duration.seconds(600),
    originOverride: true,
  },
  securityHeadersBehavior: {
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
    referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: true },
    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(365),
      includeSubdomains: true,
      override: true,
    },
    xssProtection: { protection: true, modeBlock: true, override: true },
  },
  customHeadersBehavior: {
    customHeaders: [{ header: "x-cdkrd", value: "harvest", override: true }],
  },
});

new CfFunction(stack, "CfFunction", {
  functionName: "cdkrd-fn",
  comment: "cdkrd harvest function",
  runtime: FunctionRuntime.JS_2_0,
  code: FunctionCode.fromInline("function handler(event){ return event.request; }"),
});

const publicKey = new PublicKey(stack, "PublicKey", {
  publicKeyName: "cdkrd-pub",
  comment: "cdkrd harvest public key",
  encodedKey: PUBLIC_KEY_PEM,
});

new KeyGroup(stack, "KeyGroup", {
  keyGroupName: "cdkrd-key-group",
  comment: "cdkrd harvest key group",
  items: [publicKey],
});

// --- AppMesh (mesh + virtual node with DNS service discovery + http listener) ---
const mesh = new Mesh(stack, "Mesh", {
  meshName: "cdkrd-mesh",
  egressFilter: MeshFilterType.DROP_ALL,
});

new VirtualNode(stack, "VirtualNode", {
  mesh,
  virtualNodeName: "cdkrd-node",
  serviceDiscovery: AppMeshServiceDiscovery.dns("node.cdkrd.local"),
  listeners: [
    VirtualNodeListener.http({
      port: 8080,
      healthCheck: HealthCheck.http({
        path: "/health",
        healthyThreshold: 2,
        unhealthyThreshold: 2,
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
      }),
    }),
  ],
});

// --- Lambda LayerVersion + a function with non-default async-invoke config ---
new LayerVersion(stack, "Layer", {
  layerVersionName: "cdkrd-layer",
  description: "cdkrd harvest layer",
  code: Code.fromAsset("layer"),
  compatibleRuntimes: [Runtime.NODEJS_20_X],
});

const fn = new LambdaFunction(stack, "Fn", {
  functionName: "cdkrd-fn-async",
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => {};"),
});
fn.configureAsyncInvoke({ maxEventAge: Duration.minutes(2), retryAttempts: 1 });

// --- Kinesis stream + registered consumer ---
// NB: aws-kinesis.Stream defaults to RemovalPolicy.RETAIN (applyRemovalPolicy with
// no policy = RETAIN), so without DESTROY the stream survives `cdk destroy`, leaks,
// and its fixed name collides on the next deploy. Keep this fixture self-cleaning.
const stream = new Stream(stack, "Stream", {
  streamName: "cdkrd-stream",
  shardCount: 1,
  removalPolicy: RemovalPolicy.DESTROY,
});
new StreamConsumer(stack, "Consumer", {
  stream,
  streamConsumerName: "cdkrd-consumer",
});

// --- Logs subscription filter (LogGroup -> Lambda destination) ---
const logGroup = new LogGroup(stack, "LogGroup", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});
new SubscriptionFilter(stack, "SubscriptionFilter", {
  logGroup,
  destination: new LambdaDestination(fn),
  filterPattern: FilterPattern.allTerms("ERROR"),
  filterName: "cdkrd-filter",
});

// --- ECS Fargate service (desiredCount 0 -> no steady-state wait) on a tiny VPC,
//     plus a CloudMap private namespace + service ---
const vpc = new Vpc(stack, "Vpc", {
  maxAzs: 1,
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
});

const cluster = new Cluster(stack, "Cluster", { vpc });

const taskDef = new FargateTaskDefinition(stack, "TaskDef", { cpu: 256, memoryLimitMiB: 512 });
taskDef.addContainer("app", {
  image: ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:2023"),
});

new FargateService(stack, "Service", {
  cluster,
  taskDefinition: taskDef,
  serviceName: "cdkrd-svc",
  desiredCount: 0,
  circuitBreaker: { rollback: true },
  minHealthyPercent: 50,
  maxHealthyPercent: 200,
  enableExecuteCommand: true,
  vpcSubnets: { subnetType: SubnetType.PUBLIC },
  assignPublicIp: true,
});

const namespace = new PrivateDnsNamespace(stack, "Namespace", {
  vpc,
  name: "cdkrd.internal",
  description: "cdkrd harvest namespace",
});
namespace.createService("DiscoveryService", {
  name: "svc",
  dnsRecordType: DnsRecordType.A,
  dnsTtl: Duration.seconds(60),
  customHealthCheck: { failureThreshold: 1 },
});

app.synth();

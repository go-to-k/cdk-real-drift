// Corpus-harvest fixture wave 4 (R75): the remaining HIGH-FREQUENCY service
// families real CDK apps lean on that the corpus has never seen live —
// ELBv2 (ALB + target group + listener, the single most common web entry
// point), EFS, Route53 (public zone + an ALIAS record exercising the
// Route53 SDK-override reader's AliasTarget path against real data), Cognito
// IdentityPool, Application Auto Scaling on DynamoDB (ScalableTarget +
// target-tracking policy), SSM Document, an HTTP API with an EXPLICIT stage
// (throttling), and an ECR repo with a lifecycle policy (stringly nested
// JSON doc). VPC is 1-AZ with NO NAT gateways: fast and free. The Route53
// zone is destroyed within minutes (zones deleted within 12h are not
// billed) and uses a FICTIONAL domain that is never delegated — NOT
// *.example.com, which Route53 rejects as AWS-reserved (found on the first
// live run). Everything self-cleaning.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnStage, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PredefinedMetric, ScalableTarget, ServiceNamespace } from "aws-cdk-lib/aws-applicationautoscaling";
import { CfnIdentityPool } from "aws-cdk-lib/aws-cognito";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import { FileSystem, LifecyclePolicy, PerformanceMode } from "aws-cdk-lib/aws-efs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  TargetType,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Code, Function as Fn, Runtime } from "aws-cdk-lib/aws-lambda";
import { ARecord, PublicHostedZone, RecordTarget, TxtRecord } from "aws-cdk-lib/aws-route53";
import { LoadBalancerTarget } from "aws-cdk-lib/aws-route53-targets";
import { CfnDocument } from "aws-cdk-lib/aws-ssm";

const app = new App();
const stack = new Stack(app, "CdkrdIntegHarvest4");

// ---- networking + ALB family (no NAT: cheap + fast)
const vpc = new Vpc(stack, "Net", {
  maxAzs: 2, // ALB requires 2 AZs
  natGateways: 0,
  subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC }],
});

const albSg = new SecurityGroup(stack, "AlbSg", {
  vpc,
  description: "cdkrd harvest4 alb",
  allowAllOutbound: true,
});
albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), "http in");

const alb = new ApplicationLoadBalancer(stack, "Edge", {
  vpc,
  internetFacing: true,
  securityGroup: albSg,
  idleTimeout: Duration.seconds(120),
});

const tg = new ApplicationTargetGroup(stack, "Web", {
  vpc,
  port: 8080,
  protocol: ApplicationProtocol.HTTP,
  targetType: TargetType.IP,
  healthCheck: { path: "/health", healthyThresholdCount: 3, interval: Duration.seconds(30) },
  deregistrationDelay: Duration.seconds(15),
});

alb.addListener("Http", {
  port: 80,
  defaultAction: ListenerAction.forward([tg]),
});

// ---- EFS (mount targets in the public subnets; no data = no storage cost)
new FileSystem(stack, "Files", {
  vpc,
  lifecyclePolicy: LifecyclePolicy.AFTER_14_DAYS,
  performanceMode: PerformanceMode.GENERAL_PURPOSE,
  encrypted: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

// ---- Route53: public zone + ALIAS record to the ALB + TXT record.
// The alias record runs the Route53 SDK reader's AliasTarget path live.
const zone = new PublicHostedZone(stack, "Zone", {
  zoneName: "cdkrd-harvest4-integ-fixture.com",
});
new ARecord(stack, "Apex", {
  zone,
  target: RecordTarget.fromAlias(new LoadBalancerTarget(alb)),
});
new TxtRecord(stack, "Verify", {
  zone,
  recordName: "verify",
  values: ["cdkrd-harvest4"],
  ttl: Duration.minutes(5),
});

// ---- Cognito IdentityPool (bare CFn resource; no providers)
new CfnIdentityPool(stack, "Ids", {
  identityPoolName: "cdkrd_harvest4",
  allowUnauthenticatedIdentities: false,
});

// ---- DynamoDB + Application Auto Scaling (ScalableTarget + policy)
const table = new Table(stack, "Sessions", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PROVISIONED,
  readCapacity: 1,
  writeCapacity: 1,
  removalPolicy: RemovalPolicy.DESTROY,
});
const readTarget = new ScalableTarget(stack, "ReadTarget", {
  serviceNamespace: ServiceNamespace.DYNAMODB,
  resourceId: `table/${table.tableName}`,
  scalableDimension: "dynamodb:table:ReadCapacityUnits",
  minCapacity: 1,
  maxCapacity: 5,
});
readTarget.scaleToTrackMetric("ReadUtil", {
  predefinedMetric: PredefinedMetric.DYNAMODB_READ_CAPACITY_UTILIZATION,
  targetValue: 70,
  scaleInCooldown: Duration.seconds(60),
  scaleOutCooldown: Duration.seconds(60),
});

// ---- SSM Document (Command type, YAML-able JSON content)
new CfnDocument(stack, "Runbook", {
  documentType: "Command",
  content: {
    schemaVersion: "2.2",
    description: "cdkrd harvest4 noop runbook",
    mainSteps: [
      {
        action: "aws:runShellScript",
        name: "noop",
        inputs: { runCommand: ["echo cdkrd-harvest4"] },
      },
    ],
  },
});

// ---- HTTP API with an EXPLICIT stage (throttling settings)
const fn = new Fn(stack, "ApiFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline("exports.handler = async () => ({statusCode: 200, body: 'ok'});"),
});
const api = new HttpApi(stack, "Api", { createDefaultStage: false });
api.addRoutes({ path: "/ping", integration: new HttpLambdaIntegration("Ping", fn) });
new CfnStage(stack, "Live", {
  apiId: api.apiId,
  stageName: "live",
  autoDeploy: true,
  defaultRouteSettings: { throttlingBurstLimit: 10, throttlingRateLimit: 5 },
});

// ---- ECR with a lifecycle policy (stringly nested JSON rules doc)
new Repository(stack, "Images", {
  imageTagMutability: TagMutability.IMMUTABLE,
  removalPolicy: RemovalPolicy.DESTROY,
  emptyOnDelete: true,
  lifecycleRules: [{ maxImageCount: 10, description: "keep last 10" }],
});

app.synth();

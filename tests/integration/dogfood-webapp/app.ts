// CDK app for the cdk-real-drift DOGFOOD integration test: a realistic
// multi-resource web-app + async-worker stack (NOT a single-type probe). The point
// is to surface false positives that only arise from the INTERACTION of many real
// resources with their real defaults — ALB + ECS Fargate service + task definition +
// CloudWatch logs + IAM roles/policies + security groups + DynamoDB + SQS + a Lambda
// consumer + S3 + a Secret, all wired with grants the way a real CDK user writes them.
// A clean `record` -> `check` MUST be CLEAN; any declared drift is a normalization /
// default-folding FP from a real property combination the single-type fixtures miss.
// No NAT gateway (Fargate runs in public subnets with a public IP) to bound cost.
import { App, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Cluster, ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

class DogfoodWebappStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // --- data + messaging layer ---
    const table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'by-status',
      partitionKey: { name: 'status', type: AttributeType.STRING },
    });

    const bucket = new Bucket(this, 'Assets', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const secret = new Secret(this, 'ApiKey', {
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
    });

    const dlq = new Queue(this, 'Dlq', { retentionPeriod: Duration.days(14) });
    const queue = new Queue(this, 'Jobs', {
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // --- async worker: Lambda consuming the queue, reading the table/bucket/secret ---
    const worker = new LambdaFunction(this, 'Worker', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(
        'exports.handler = async (e) => { console.log(JSON.stringify(e)); return {}; };'
      ),
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: { TABLE: table.tableName, BUCKET: bucket.bucketName, SECRET: secret.secretArn },
      logRetention: RetentionDays.ONE_WEEK,
    });
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 10 }));
    table.grantReadWriteData(worker);
    bucket.grantRead(worker);
    secret.grantRead(worker);

    // --- web tier: an internet-facing ALB in front of a Fargate service ---
    const cluster = new Cluster(this, 'Cluster', { vpc, containerInsights: true });
    const web = new ApplicationLoadBalancedFargateService(this, 'Web', {
      cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      assignPublicIp: true,
      taskSubnets: { subnetType: SubnetType.PUBLIC },
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ContainerImage.fromRegistry('public.ecr.aws/docker/library/httpd:2.4'),
        containerPort: 80,
        environment: { QUEUE_URL: queue.queueUrl, TABLE: table.tableName },
      },
    });
    web.targetGroup.configureHealthCheck({ path: '/', healthyHttpCodes: '200-399' });
    // the web task may enqueue jobs + read its data
    queue.grantSendMessages(web.taskDefinition.taskRole);
    table.grantReadData(web.taskDefinition.taskRole);
  }
}

const app = new App();
new DogfoodWebappStack(app, 'CdkRealDriftIntegDogfoodWebapp', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

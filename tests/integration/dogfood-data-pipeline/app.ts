// CDK app for the cdk-real-drift DOGFOOD #3: a realistic streaming DATA PIPELINE
// stack (a third interaction surface, after the ALB/ECS web app and the serverless
// API). A Kinesis data stream feeds a Firehose delivery stream that runs records
// through a Lambda transform (a ProcessingConfiguration with Parameters — the shape
// that produced a real reorder+subset FP in #340) and lands GZIP'd objects in S3,
// with CloudWatch error logging; a Glue database + table provide the data catalog.
// The point is to surface false positives from the INTERACTION of Kinesis + Firehose
// (its nested ProcessingConfiguration / S3 destination config) + Glue + S3 + the Lambda
// transform + the IAM delivery role wiring them. A clean `record` -> `check` MUST be
// CLEAN; any declared drift is a normalization / default-folding FP.
import { App, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { Stream, StreamMode } from 'aws-cdk-lib/aws-kinesis';
import { CfnDeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, LogStream, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

class DogfoodDataPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const source = new Stream(this, 'Source', {
      streamMode: StreamMode.PROVISIONED,
      shardCount: 1,
      retentionPeriod: Duration.hours(24),
    });

    const bucket = new Bucket(this, 'Lake', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Glue data catalog over the lake.
    const db = new CfnDatabase(this, 'Db', {
      catalogId: this.account,
      databaseInput: { name: 'cdkrd_pipeline', description: 'cdkrd dogfood catalog' },
    });
    new CfnTable(this, 'Events', {
      catalogId: this.account,
      databaseName: 'cdkrd_pipeline',
      tableInput: {
        name: 'events',
        tableType: 'EXTERNAL_TABLE',
        parameters: { classification: 'parquet' },
        storageDescriptor: {
          location: `s3://${bucket.bucketName}/events/`,
          columns: [
            { name: 'id', type: 'string' },
            { name: 'ts', type: 'bigint' },
            { name: 'payload', type: 'string' },
          ],
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
        },
      },
    }).addDependency(db);

    const transform = new LambdaFunction(this, 'Transform', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(
        'exports.handler = async (e) => ({ records: e.records.map(r => ({ recordId: r.recordId, result: "Ok", data: r.data })) });'
      ),
      memorySize: 256,
      timeout: Duration.minutes(1),
      logRetention: RetentionDays.ONE_WEEK,
    });

    const logGroup = new LogGroup(this, 'FhLog', {
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logStream = new LogStream(this, 'FhLogStream', {
      logGroup,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Firehose delivery role with access to the source stream, the lake, the transform.
    const fhRole = new Role(this, 'FhRole', {
      assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
    });
    bucket.grantReadWrite(fhRole);
    source.grantRead(fhRole);
    transform.grantInvoke(fhRole);
    fhRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      })
    );

    const firehose = new CfnDeliveryStream(this, 'Firehose', {
      deliveryStreamType: 'KinesisStreamAsSource',
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: source.streamArn,
        roleArn: fhRole.roleArn,
      },
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: fhRole.roleArn,
        prefix: 'events/',
        errorOutputPrefix: 'errors/',
        compressionFormat: 'GZIP',
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: logGroup.logGroupName,
          logStreamName: logStream.logStreamName,
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                { parameterName: 'LambdaArn', parameterValue: transform.functionArn },
                { parameterName: 'BufferSizeInMBs', parameterValue: '1' },
                { parameterName: 'BufferIntervalInSeconds', parameterValue: '60' },
              ],
            },
          ],
        },
      },
    });
    // Firehose validates the role can DescribeStream AT CREATE TIME, so the role's
    // grant policy must exist first — depend on it explicitly to avoid the IAM race.
    const fhRolePolicy = fhRole.node.tryFindChild('DefaultPolicy');
    if (fhRolePolicy) firehose.node.addDependency(fhRolePolicy);
  }
}

const app = new App();
new DogfoodDataPipelineStack(app, 'CdkRealDriftIntegDogfoodDataPipeline', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

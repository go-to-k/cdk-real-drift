// CDK app for the cdk-real-drift DOGFOOD (analytics domain): an Athena WorkGroup +
// NamedQuery over a Glue data catalog (database + table) with results landing in S3.
// Athena is free (no infra); NamedQuery is an uncovered type. Exercises the Athena <->
// Glue <-> S3 interaction. A clean `record` -> `check` MUST be CLEAN; any declared
// drift is a normalization / default-folding FP.
import { App, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnNamedQuery, CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

class DogfoodAnalyticsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const results = new Bucket(this, 'Results', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const data = new Bucket(this, 'Data', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const db = new CfnDatabase(this, 'Db', {
      catalogId: this.account,
      databaseInput: { name: 'cdkrd_analytics' },
    });
    new CfnTable(this, 'Logs', {
      catalogId: this.account,
      databaseName: 'cdkrd_analytics',
      tableInput: {
        name: 'logs',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          location: `s3://${data.bucketName}/logs/`,
          columns: [
            { name: 'ts', type: 'string' },
            { name: 'level', type: 'string' },
            { name: 'msg', type: 'string' },
          ],
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
          },
        },
      },
    }).addDependency(db);

    const wg = new CfnWorkGroup(this, 'Wg', {
      name: 'cdkrd-analytics',
      workGroupConfiguration: {
        resultConfiguration: { outputLocation: `s3://${results.bucketName}/athena/` },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
      },
    });

    new CfnNamedQuery(this, 'TopErrors', {
      database: 'cdkrd_analytics',
      workGroup: wg.name,
      name: 'top-errors',
      queryString: "SELECT msg, count(*) c FROM logs WHERE level = 'ERROR' GROUP BY msg ORDER BY c DESC",
    }).addDependency(wg);
  }
}

const app = new App();
new DogfoodAnalyticsStack(app, 'CdkRealDriftIntegDogfoodAnalytics', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

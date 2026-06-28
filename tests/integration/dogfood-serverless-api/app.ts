// CDK app for the cdk-real-drift DOGFOOD #2: a realistic SERVERLESS API stack (a
// different interaction surface from the ALB/ECS dogfood-webapp). A REST API Gateway
// with Lambda-integrated methods behind a Cognito User Pools authorizer, backed by a
// DynamoDB table, with an SQS dead-letter queue and a usage plan + API key. The point
// is to surface false positives from the INTERACTION of API Gateway's child resources
// (RestApi + Resource + Method + Deployment + Stage + Authorizer + UsagePlan), Cognito
// (UserPool + Client + Domain), Lambda, DynamoDB, and the IAM grants wiring them — the
// kind of real combination a serverless app actually deploys. A clean `record` ->
// `check` MUST be CLEAN; any declared drift is a normalization / default-folding FP.
import { App, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  Cors,
  LambdaIntegration,
  Period,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

class DogfoodServerlessApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new Table(this, 'Items', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const dlq = new Queue(this, 'ApiDlq', { retentionPeriod: Duration.days(14) });

    const handler = new LambdaFunction(this, 'Api', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
      ),
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE: table.tableName },
      deadLetterQueue: dlq,
      logRetention: RetentionDays.ONE_WEEK,
    });
    table.grantReadWriteData(handler);

    // Cognito user pool + client + an authorizer guarding the API.
    const userPool = new UserPool(this, 'Users', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const userPoolClient = new UserPoolClient(this, 'UsersClient', {
      userPool,
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
    });
    const authorizer = new CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
    });

    const api = new RestApi(this, 'Rest', {
      deployOptions: { stageName: 'prod', throttlingBurstLimit: 100, throttlingRateLimit: 50 },
      defaultCorsPreflightOptions: { allowOrigins: Cors.ALL_ORIGINS, allowMethods: Cors.ALL_METHODS },
    });
    const items = api.root.addResource('items');
    items.addMethod('GET', new LambdaIntegration(handler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });
    items.addMethod('POST', new LambdaIntegration(handler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });
    const item = items.addResource('{id}');
    item.addMethod('GET', new LambdaIntegration(handler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    // a usage plan + API key (a common real serverless add-on)
    const key = api.addApiKey('ApiKey');
    const plan = api.addUsagePlan('Plan', {
      throttle: { burstLimit: 50, rateLimit: 20 },
      quota: { limit: 10000, period: Period.MONTH },
    });
    plan.addApiKey(key);
    plan.addApiStage({ stage: api.deploymentStage });

    void userPoolClient;
  }
}

const app = new App();
new DogfoodServerlessApiStack(app, 'CdkRealDriftIntegDogfoodServerlessApi', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

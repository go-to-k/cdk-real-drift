// CDK app for the cdk-real-drift DOGFOOD #4: a realistic EVENT-DRIVEN orchestration
// stack (a fourth interaction surface, after the web app, the serverless API, and the
// data pipeline). A Step Functions state machine (a Lambda task -> SNS publish, with
// CloudWatch logging + X-Ray tracing) is triggered by an EventBridge rule (a custom
// event pattern, with a dead-letter queue + retry policy on the target), backed by a
// DynamoDB table and an SNS topic with an SQS subscriber. The point is to surface
// false positives from the INTERACTION of Step Functions (its DefinitionString /
// LoggingConfiguration / TracingConfiguration), EventBridge (the rule's Targets array
// with RoleArn / DeadLetterConfig / RetryPolicy), Lambda, SNS, SQS, DynamoDB and the
// IAM grants wiring them. A clean `record` -> `check` MUST be CLEAN; any declared
// drift is a normalization / default-folding FP.
import { App, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import {
  Choice,
  Condition,
  DefinitionBody,
  LogLevel,
  Pass,
  StateMachine,
  Succeed,
  TaskInput,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke, SnsPublish } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';

class DogfoodEventDrivenStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new Table(this, 'State', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const topic = new Topic(this, 'Notify');
    const subscriberDlq = new Queue(this, 'SubDlq');
    const subscriberQueue = new Queue(this, 'SubQueue', { visibilityTimeout: Duration.seconds(60) });
    topic.addSubscription(new SqsSubscription(subscriberQueue, { deadLetterQueue: subscriberDlq }));

    const worker = new LambdaFunction(this, 'Worker', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async (e) => ({ ok: true, n: (e.n || 0) + 1 });'),
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: { TABLE: table.tableName },
      logRetention: RetentionDays.ONE_WEEK,
    });
    table.grantReadWriteData(worker);

    // Step Functions workflow: invoke the worker, branch, publish to SNS.
    const invoke = new LambdaInvoke(this, 'Invoke', { lambdaFunction: worker, outputPath: '$.Payload' });
    const publish = new SnsPublish(this, 'Publish', {
      topic,
      message: TaskInput.fromJsonPathAt('$'),
      subject: 'workflow-done',
    });
    const definition = invoke.next(
      new Choice(this, 'Ok?')
        .when(Condition.booleanEquals('$.ok', true), publish.next(new Succeed(this, 'Done')))
        .otherwise(new Pass(this, 'Skip'))
    );

    const smLog = new LogGroup(this, 'SmLog', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const machine = new StateMachine(this, 'Machine', {
      definitionBody: DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
      logs: { destination: smLog, level: LogLevel.ALL, includeExecutionData: true },
      timeout: Duration.minutes(5),
    });

    // EventBridge rule (custom event pattern) -> the state machine, with a DLQ + retry.
    const ruleDlq = new Queue(this, 'RuleDlq');
    new Rule(this, 'OnOrder', {
      eventPattern: { source: ['cdkrd.orders'], detailType: ['OrderPlaced'] },
      targets: [
        new SfnStateMachine(machine, {
          deadLetterQueue: ruleDlq,
          retryAttempts: 3,
          maxEventAge: Duration.hours(1),
        }),
      ],
    });
  }
}

const app = new App();
new DogfoodEventDrivenStack(app, 'CdkRealDriftIntegDogfoodEventDriven', {
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

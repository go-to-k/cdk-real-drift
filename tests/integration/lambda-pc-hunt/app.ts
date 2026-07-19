// False-positive probe: Lambda provisioned concurrency (the first fixture to exercise
// AWS::Lambda::Alias with ProvisionedConcurrencyConfig — a very common production
// hardening measure with zero prior corpus/fixture coverage). The alias declares only
// the concurrency; everything AWS materializes around it (routing config, PC state)
// is the undeclared surface under probe.
import { App, Duration, Stack, Tags } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const app = new App();
Tags.of(app).add('cdkrd:ephemeral', '1');

const stack = new Stack(app, 'CdkrdHunt0720LambdaPc');

const fn = new lambda.Function(stack, 'Fn', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline('exports.handler = async () => "ok";'),
  memorySize: 128,
  timeout: Duration.seconds(3),
});

new lambda.Alias(stack, 'LiveAlias', {
  aliasName: 'live',
  version: fn.currentVersion,
  provisionedConcurrentExecutions: 1,
});

app.synth();

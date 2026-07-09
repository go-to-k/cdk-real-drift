// #845 — DERIVED first-run echoes (classify.ts tier-2 folds computed from declared inputs,
// plus one symmetric CC_ALT_REPRESENTATION drop). Each fold satisfies the zero-first-run
// invariant on a clean deploy while PRESERVING detection: a value diverging from the derived
// default still surfaces as undeclared drift.
//   - CodeBuild Artifacts.Name echoes the declared project Name,
//   - Secrets RotationRules.AutomaticallyAfterDays derived from the declared rate(N days),
//   - NLB live-only Subnets dropped when SubnetMappings is declared (symmetric alt rep),
//   - AmazonMQ ACTIVEMQ StorageType default EFS,
//   - Firehose Lambda-processor Parameters[NumberOfRetries] default "3".
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const allPaths = (fs: Finding[]) => fs.map((f) => f.path).sort();
const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId,
  declared,
});

describe('#845 CodeBuild Artifacts.Name echoes declared project Name', () => {
  it('folds Artifacts.Name to atDefault when it equals the declared Name', () => {
    const res = mk('AWS::CodeBuild::Project', {
      Name: 'my-build',
      Artifacts: { Type: 'CODEPIPELINE' },
    });
    const f = classifyResource(
      res,
      {
        Name: 'my-build',
        Artifacts: { Type: 'CODEPIPELINE', Name: 'my-build' },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('Artifacts.Name');
    expect(tier(f, 'undeclared')).not.toContain('Artifacts.Name');
  });
  it('surfaces Artifacts.Name when it diverges from the declared Name — detection preserved', () => {
    const res = mk('AWS::CodeBuild::Project', {
      Name: 'my-build',
      Artifacts: { Type: 'CODEPIPELINE' },
    });
    const f = classifyResource(
      res,
      {
        Name: 'my-build',
        Artifacts: { Type: 'CODEPIPELINE', Name: 'renamed-artifact' },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('Artifacts.Name');
  });
});

describe('#845 Secrets RotationRules.AutomaticallyAfterDays derived from rate(N days)', () => {
  it('folds AutomaticallyAfterDays to atDefault when it equals the declared rate day count', () => {
    const res = mk('AWS::SecretsManager::RotationSchedule', {
      RotationRules: { ScheduleExpression: 'rate(30 days)' },
    });
    const f = classifyResource(
      res,
      { RotationRules: { ScheduleExpression: 'rate(30 days)', AutomaticallyAfterDays: 30 } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('RotationRules.AutomaticallyAfterDays');
    expect(tier(f, 'undeclared')).not.toContain('RotationRules.AutomaticallyAfterDays');
  });
  it('surfaces AutomaticallyAfterDays when it diverges from the declared rate — detection preserved', () => {
    const res = mk('AWS::SecretsManager::RotationSchedule', {
      RotationRules: { ScheduleExpression: 'rate(30 days)' },
    });
    const f = classifyResource(
      res,
      { RotationRules: { ScheduleExpression: 'rate(30 days)', AutomaticallyAfterDays: 7 } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('RotationRules.AutomaticallyAfterDays');
  });
});

describe('#845 NLB live-only Subnets dropped when SubnetMappings declared', () => {
  it('drops the live-only Subnets scalar mirror when SubnetMappings is declared', () => {
    const res = mk('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network',
      SubnetMappings: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
    });
    const f = classifyResource(
      res,
      {
        Type: 'network',
        SubnetMappings: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
        Subnets: ['subnet-a', 'subnet-b'],
      },
      emptySchema
    );
    expect(allPaths(f)).not.toContain('Subnets');
  });
});

describe('#845 AmazonMQ ACTIVEMQ StorageType default EFS', () => {
  it('folds StorageType EFS to atDefault for an ACTIVEMQ broker declaring no StorageType', () => {
    const res = mk('AWS::AmazonMQ::Broker', {
      EngineType: 'ACTIVEMQ',
      DeploymentMode: 'SINGLE_INSTANCE',
    });
    const f = classifyResource(res, { EngineType: 'ACTIVEMQ', StorageType: 'EFS' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('StorageType');
    expect(tier(f, 'undeclared')).not.toContain('StorageType');
  });
  it('surfaces an ACTIVEMQ broker whose StorageType is EBS (away from the EFS default) — detection preserved', () => {
    const res = mk('AWS::AmazonMQ::Broker', {
      EngineType: 'ACTIVEMQ',
      DeploymentMode: 'SINGLE_INSTANCE',
    });
    const f = classifyResource(res, { EngineType: 'ACTIVEMQ', StorageType: 'EBS' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('StorageType');
  });
});

describe('#845 Firehose Lambda-processor Parameters[NumberOfRetries] default "3"', () => {
  const roleArn = 'arn:aws:iam::111111111111:role/r';
  const lambdaArn = 'arn:aws:lambda:us-east-1:111111111111:function:f';
  const declaredProc = {
    ExtendedS3DestinationConfiguration: {
      ProcessingConfiguration: {
        Enabled: true,
        Processors: [
          {
            Type: 'Lambda',
            Parameters: [{ ParameterName: 'LambdaArn', ParameterValue: lambdaArn }],
          },
        ],
      },
      RoleARN: roleArn,
    },
  };
  const liveProc = (retries: string) => ({
    ExtendedS3DestinationConfiguration: {
      ProcessingConfiguration: {
        Enabled: true,
        Processors: [
          {
            Type: 'Lambda',
            Parameters: [
              { ParameterName: 'LambdaArn', ParameterValue: lambdaArn },
              { ParameterName: 'NumberOfRetries', ParameterValue: retries },
            ],
          },
        ],
      },
      RoleARN: roleArn,
    },
  });
  const retriesPath =
    'ExtendedS3DestinationConfiguration.ProcessingConfiguration.Processors.0.Parameters[NumberOfRetries]';
  it('folds the server-injected NumberOfRetries "3" to atDefault', () => {
    const f = classifyResource(
      mk('AWS::KinesisFirehose::DeliveryStream', declaredProc),
      liveProc('3'),
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain(retriesPath);
    expect(tier(f, 'undeclared')).not.toContain(retriesPath);
  });
  it('surfaces a non-default NumberOfRetries "5" — detection preserved', () => {
    const f = classifyResource(
      mk('AWS::KinesisFirehose::DeliveryStream', declaredProc),
      liveProc('5'),
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain(retriesPath);
  });
});

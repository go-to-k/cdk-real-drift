// #653 corpus-mining batch — first-run fold gaps on 13+ covered types. Each fold is an
// equality-gated constant, a derived default, or (only for undeclared AWS-assigned values)
// value-independent / generated. Every test asserts BOTH the fold AND that a genuine
// divergence still surfaces where the fold is meaningful.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, matchesKnownDefault } from '../src/diff/classify.js';
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

describe('matchesKnownDefault is recursively subset-tolerant', () => {
  const def = { a: 1, b: { c: 2, d: { e: 3, f: 4 } } };
  it('folds a live echo that omits nested sub-keys at any depth', () => {
    expect(matchesKnownDefault({ a: 1, b: { c: 2, d: { e: 3 } } }, def)).toBe(true);
    expect(matchesKnownDefault({ b: {} }, def)).toBe(true);
  });
  it('still surfaces a nested value changed away from the default', () => {
    expect(matchesKnownDefault({ b: { d: { e: 99 } } }, def)).toBe(false);
  });
  it('still surfaces an extra non-trivial nested key the default does not list', () => {
    expect(matchesKnownDefault({ b: { d: { e: 3, z: 1 } } }, def)).toBe(false);
  });
});

describe('#653 ECS DeploymentConfiguration default (enriched shape, both echoes fold)', () => {
  const res = mk('AWS::ECS::Service', { SchedulingStrategy: 'REPLICA' });
  const enriched = {
    BakeTimeInMinutes: 0,
    Alarms: { AlarmNames: [], Enable: false, Rollback: false },
    Strategy: 'ROLLING',
    DeploymentCircuitBreaker: {
      ThresholdConfiguration: { Type: 'BOUNDED_PERCENT', Value: 50 },
      Enable: false,
      ResetOnHealthyTask: true,
      Rollback: false,
    },
    MaximumPercent: 200,
    MinimumHealthyPercent: 100,
  };
  it("folds today's enriched whole-object default", () => {
    expect(
      tier(classifyResource(res, { DeploymentConfiguration: enriched }, emptySchema), 'atDefault')
    ).toContain('DeploymentConfiguration');
  });
  it('folds an OLDER pre-enrichment echo (fewer circuit-breaker keys) too', () => {
    const old = {
      BakeTimeInMinutes: 0,
      Strategy: 'ROLLING',
      DeploymentCircuitBreaker: { Enable: false, Rollback: false },
      MaximumPercent: 200,
      MinimumHealthyPercent: 100,
    };
    expect(
      tier(classifyResource(res, { DeploymentConfiguration: old }, emptySchema), 'atDefault')
    ).toContain('DeploymentConfiguration');
  });
  it('surfaces a service that actually enabled the circuit breaker', () => {
    const on = {
      ...enriched,
      DeploymentCircuitBreaker: { ...enriched.DeploymentCircuitBreaker, Enable: true },
    };
    expect(
      tier(classifyResource(res, { DeploymentConfiguration: on }, emptySchema), 'undeclared')
    ).toContain('DeploymentConfiguration');
  });
});

describe('#653 constant defaults fold, changes surface', () => {
  it('SES EmailIdentity DKIM/feedback defaults', () => {
    const f = classifyResource(
      mk('AWS::SES::EmailIdentity', { EmailIdentity: 'x@y.com' }),
      {
        DkimAttributes: { SigningEnabled: true },
        FeedbackAttributes: { EmailForwardingEnabled: true },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['DkimAttributes', 'FeedbackAttributes'])
    );
    const changed = classifyResource(
      mk('AWS::SES::EmailIdentity', { EmailIdentity: 'x@y.com' }),
      { DkimSigningAttributes: { NextSigningKeyLength: 'RSA_1024_BIT' } },
      emptySchema
    );
    expect(tier(changed, 'undeclared')).toContain('DkimSigningAttributes');
  });
  it('Glue Job Timeout/ExecutionProperty', () => {
    const f = classifyResource(
      mk('AWS::Glue::Job', { Role: 'r' }),
      { Timeout: 2880, ExecutionProperty: { MaxConcurrentRuns: 1 } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(expect.arrayContaining(['Timeout', 'ExecutionProperty']));
    expect(
      tier(
        classifyResource(mk('AWS::Glue::Job', { Role: 'r' }), { Timeout: 60 }, emptySchema),
        'undeclared'
      )
    ).toContain('Timeout');
  });
  it('EKS AccessConfig CONFIG_MAP', () => {
    expect(
      tier(
        classifyResource(
          mk('AWS::EKS::Cluster', { Name: 'c' }),
          { AccessConfig: { AuthenticationMode: 'CONFIG_MAP' } },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('AccessConfig');
    expect(
      tier(
        classifyResource(
          mk('AWS::EKS::Cluster', { Name: 'c' }),
          { AccessConfig: { AuthenticationMode: 'API' } },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('AccessConfig');
  });
  it('Signer SignatureValidityPeriod / Lambda CodeSigningConfig / SG default egress', () => {
    expect(
      tier(
        classifyResource(
          mk('AWS::Signer::SigningProfile', { PlatformId: 'p' }),
          { SignatureValidityPeriod: { Type: 'MONTHS', Value: 135 } },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('SignatureValidityPeriod');
    expect(
      tier(
        classifyResource(
          mk('AWS::Lambda::CodeSigningConfig', { AllowedPublishers: {} }),
          { CodeSigningPolicies: { UntrustedArtifactOnDeployment: 'Warn' } },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('CodeSigningPolicies');
    expect(
      tier(
        classifyResource(
          mk('AWS::EC2::SecurityGroup', { GroupDescription: 'd' }),
          {
            SecurityGroupEgress: [
              { CidrIp: '0.0.0.0/0', FromPort: -1, ToPort: -1, IpProtocol: '-1' },
            ],
          },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('SecurityGroupEgress');
  });
  it('Bedrock Guardrail nested tier config', () => {
    const f = classifyResource(
      mk('AWS::Bedrock::Guardrail', { ContentPolicyConfig: { FiltersConfig: [] } }),
      {
        ContentPolicyConfig: {
          FiltersConfig: [],
          ContentFiltersTierConfig: { TierName: 'CLASSIC' },
        },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('ContentPolicyConfig.ContentFiltersTierConfig');
  });
});

describe('#653 ElastiCache Port derived from engine', () => {
  it('folds 6379 for redis, 11211 for memcached, surfaces a custom port', () => {
    expect(
      tier(
        classifyResource(
          mk('AWS::ElastiCache::CacheCluster', { CacheNodeType: 't3.micro' }),
          { Engine: 'redis', Port: 6379 },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('Port');
    expect(
      tier(
        classifyResource(
          mk('AWS::ElastiCache::CacheCluster', { CacheNodeType: 't3.micro' }),
          { Engine: 'memcached', Port: 11211 },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('Port');
    expect(
      tier(
        classifyResource(
          mk('AWS::ElastiCache::CacheCluster', { CacheNodeType: 't3.micro' }),
          { Engine: 'redis', Port: 7000 },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('Port');
  });
});

describe('#653 Glue Schema Registry.Name derived from declared ARN tail', () => {
  const res = mk('AWS::Glue::Schema', {
    Registry: { Arn: 'arn:aws:glue:us-east-1:111111111111:registry/my-reg' },
  });
  it('folds the echoed registry name', () => {
    expect(
      tier(
        classifyResource(
          res,
          {
            Registry: {
              Arn: 'arn:aws:glue:us-east-1:111111111111:registry/my-reg',
              Name: 'my-reg',
            },
          },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('Registry.Name');
  });
  it('surfaces a name that does not match the declared registry', () => {
    expect(
      tier(
        classifyResource(
          res,
          {
            Registry: {
              Arn: 'arn:aws:glue:us-east-1:111111111111:registry/my-reg',
              Name: 'other-reg',
            },
          },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('Registry.Name');
  });
});

describe('#653 value-independent / generated undeclared identifiers', () => {
  it('EFS KmsKeyId folds any managed-key ARN', () => {
    expect(
      tier(
        classifyResource(
          mk('AWS::EFS::FileSystem', { Encrypted: true }),
          { KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc' },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('KmsKeyId');
  });
  it('EIP NetworkInterfaceId with a declared sibling folds; sibling-less surfaces (#892)', () => {
    // A sibling-explained association (a declared EIPAssociation / NAT gateway consuming this EIP,
    // recorded in opts.siblingEipAssociations by gather.buildSiblingEipAssociations) is IaC intent
    // → the reflected id is dropped (no NetworkInterfaceId finding at all).
    expect(
      classifyResource(
        mk('AWS::EC2::EIP', { Domain: 'vpc' }),
        { NetworkInterfaceId: 'eni-123' },
        emptySchema,
        { siblingEipAssociations: new Set(['R']) } // 'R' == mk's logicalId
      ).some((f) => f.path === 'NetworkInterfaceId')
    ).toBe(false);
    // With NO declaring sibling the live association is an out-of-band associate-address hijack of
    // the allocated static IP and must SURFACE as undeclared drift (the blanket fold hid it).
    expect(
      tier(
        classifyResource(
          mk('AWS::EC2::EIP', { Domain: 'vpc' }),
          { NetworkInterfaceId: 'eni-123' },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('NetworkInterfaceId');
  });
  it('GlobalAccelerator IpAddresses fold', () => {
    expect(
      tier(
        classifyResource(
          mk('AWS::GlobalAccelerator::Accelerator', { Name: 'a' }),
          { IpAddresses: ['52.1.2.3'] },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('IpAddresses');
  });
  it('Budgets BudgetName folds as generated (echoes the physical id)', () => {
    const name = 'MonthlyCost-us-east-1-1679810595490-abcDEFghij';
    expect(
      tier(
        classifyResource(
          mk('AWS::Budgets::Budget', { Budget: { BudgetType: 'COST' } }, name),
          { Budget: { BudgetType: 'COST', BudgetName: name } },
          emptySchema
        ),
        'generated'
      )
    ).toContain('Budget.BudgetName');
  });
});

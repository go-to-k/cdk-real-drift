// #701 minimal-config first-run batch — daily-driver props that every existing fixture
// DECLARES, so their undeclared-default folds were never exercised (the #615 lesson).
// Each test asserts BOTH the fold AND that a genuine divergence still surfaces where the
// value is meaningful.
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
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#701 ALB Scheme/Type constants + SecurityGroups value-independent', () => {
  const res = mk('AWS::ElasticLoadBalancingV2::LoadBalancer', { Name: 'lb' });
  it('folds internet-facing/application/default-SG on a bare LB', () => {
    const f = classifyResource(
      res,
      { Scheme: 'internet-facing', Type: 'application', SecurityGroups: ['sg-0b42abc'] },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['Scheme', 'Type', 'SecurityGroups'])
    );
    expect(tier(f, 'undeclared')).toEqual([]);
  });
  it('surfaces an internal scheme / NLB type', () => {
    expect(
      tier(classifyResource(res, { Scheme: 'internal' }, emptySchema), 'undeclared')
    ).toContain('Scheme');
    expect(tier(classifyResource(res, { Type: 'network' }, emptySchema), 'undeclared')).toContain(
      'Type'
    );
  });
});

describe('#701 Events Rule State / EIP Domain constants', () => {
  it('folds ENABLED / vpc, surfaces DISABLED', () => {
    expect(
      tier(
        classifyResource(mk('AWS::Events::Rule', { Name: 'r' }), { State: 'ENABLED' }, emptySchema),
        'atDefault'
      )
    ).toContain('State');
    expect(
      tier(
        classifyResource(
          mk('AWS::Events::Rule', { Name: 'r' }),
          { State: 'DISABLED' },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('State');
    expect(
      tier(classifyResource(mk('AWS::EC2::EIP', {}), { Domain: 'vpc' }, emptySchema), 'atDefault')
    ).toContain('Domain');
  });
});

describe('#701 Cognito bare-pool defaults', () => {
  const res = mk('AWS::Cognito::UserPool', { MfaConfiguration: 'OFF' });
  it('folds VerificationMessageTemplate + AccountRecoverySetting', () => {
    const f = classifyResource(
      res,
      {
        VerificationMessageTemplate: { DefaultEmailOption: 'CONFIRM_WITH_CODE' },
        AccountRecoverySetting: {
          RecoveryMechanisms: [
            { Priority: 1, Name: 'verified_email' },
            { Priority: 2, Name: 'verified_phone_number' },
          ],
        },
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['VerificationMessageTemplate', 'AccountRecoverySetting'])
    );
  });
  it('surfaces a link-based verification option', () => {
    expect(
      tier(
        classifyResource(
          res,
          { VerificationMessageTemplate: { DefaultEmailOption: 'CONFIRM_WITH_LINK' } },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('VerificationMessageTemplate');
  });
});

describe('#701 EventSourceMapping BatchSize derived from the source service', () => {
  const esm = (arn: string) =>
    mk('AWS::Lambda::EventSourceMapping', { EventSourceArn: arn, FunctionName: 'f' });
  it('folds 10 for SQS, 100 for Kinesis/DynamoDB/Kafka', () => {
    expect(
      tier(
        classifyResource(
          esm('arn:aws:sqs:us-east-1:111111111111:q'),
          { BatchSize: 10 },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('BatchSize');
    expect(
      tier(
        classifyResource(
          esm('arn:aws:kinesis:us-east-1:111111111111:stream/s'),
          { BatchSize: 100 },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('BatchSize');
    expect(
      tier(
        classifyResource(
          esm('arn:aws:dynamodb:us-east-1:111111111111:table/t/stream/x'),
          { BatchSize: 100 },
          emptySchema
        ),
        'atDefault'
      )
    ).toContain('BatchSize');
  });
  it('surfaces a custom batch size', () => {
    expect(
      tier(
        classifyResource(
          esm('arn:aws:sqs:us-east-1:111111111111:q'),
          { BatchSize: 5 },
          emptySchema
        ),
        'undeclared'
      )
    ).toContain('BatchSize');
  });
});

describe('#701 KMS default KeyPolicy derived from the account root', () => {
  const res = mk('AWS::KMS::Key', { Description: 'k' });
  const opts = { accountId: '111111111111', region: 'us-east-1' };
  const defaultPolicy = {
    Version: '2012-10-17',
    Id: 'key-default-1',
    Statement: [
      {
        Sid: 'Enable IAM User Permissions',
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::111111111111:root' },
        Action: 'kms:*',
        Resource: '*',
      },
    ],
  };
  it('folds the raw default root policy (Sid/Id normalized away) to atDefault', () => {
    const f = classifyResource(res, { KeyPolicy: defaultPolicy }, emptySchema, opts);
    expect(tier(f, 'atDefault')).toContain('KeyPolicy');
    expect(tier(f, 'undeclared')).not.toContain('KeyPolicy');
  });
  it('surfaces a policy scoped to a different principal', () => {
    const scoped = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: 'arn:aws:iam::999999999999:root' },
          Action: 'kms:*',
          Resource: '*',
        },
      ],
    };
    expect(
      tier(classifyResource(res, { KeyPolicy: scoped }, emptySchema, opts), 'undeclared')
    ).toContain('KeyPolicy');
  });
  // #945: the KMS site now derives the partition from the canonical partitionForRegion helper
  // (folds the ISO partitions the old cn-/us-gov--only ternary missed). Note the root-ARN
  // principal is already partition-tolerant — policy-canonical reduces `arn:aws*:iam::<acct>:root`
  // to the bare account id — so this fold landed even before the fix; this guards that ISO regions
  // stay ZERO potential drift on the default KeyPolicy regardless of the built prefix.
  it.each([
    ['us-iso-east-1', 'aws-iso'],
    ['eu-isoe-west-1', 'aws-iso-e'],
  ])('folds the ISO-partition default root policy in %s (partition %s)', (region, partition) => {
    const isoPolicy = {
      Version: '2012-10-17',
      Id: 'key-default-1',
      Statement: [
        {
          Sid: 'Enable IAM User Permissions',
          Effect: 'Allow',
          Principal: { AWS: `arn:${partition}:iam::111111111111:root` },
          Action: 'kms:*',
          Resource: '*',
        },
      ],
    };
    const f = classifyResource(res, { KeyPolicy: isoPolicy }, emptySchema, {
      accountId: '111111111111',
      region,
    });
    expect(tier(f, 'atDefault')).toContain('KeyPolicy');
    expect(tier(f, 'undeclared')).not.toContain('KeyPolicy');
  });
});

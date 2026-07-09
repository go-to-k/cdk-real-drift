// First-run fold gaps mined from clean, un-mutated deploys (issues #642, #643, #668,
// #678). Each fold is equality-gated or derived, so a change away from the default
// still surfaces — every test asserts BOTH the fold (atDefault / no declared drift on a
// clean deploy) AND that a genuine divergence still surfaces.
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#642 ApiGateway GatewayResponse ResponseTemplates default', () => {
  const res: DesiredResource = {
    logicalId: 'GwResponse',
    resourceType: 'AWS::ApiGateway::GatewayResponse',
    physicalId: 'api:DEFAULT_4XX',
    declared: { ResponseType: 'DEFAULT_4XX', RestApiId: 'api' },
  };
  it('folds the constant default template to atDefault', () => {
    const f = classifyResource(
      res,
      { ResponseTemplates: { 'application/json': '{"message":$context.error.messageString}' } },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('ResponseTemplates');
    expect(pathsByTier(f, 'undeclared')).not.toContain('ResponseTemplates');
  });
  it('surfaces a customized template as undeclared', () => {
    const f = classifyResource(
      res,
      { ResponseTemplates: { 'application/json': '{"custom":true}' } },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('ResponseTemplates');
  });
});

describe('#642 Cognito UnusedAccountValidityDays mirrors declared TemporaryPasswordValidityDays', () => {
  const mk = (tpvd: number): DesiredResource => ({
    logicalId: 'Pool',
    resourceType: 'AWS::Cognito::UserPool',
    physicalId: 'pool',
    declared: {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      Policies: { PasswordPolicy: { TemporaryPasswordValidityDays: tpvd } },
    },
  });
  const live = (uavd: number) => ({
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: false, UnusedAccountValidityDays: uavd },
  });
  it('folds when the alias mirrors the declared non-7 lifetime', () => {
    const f = classifyResource(mk(3), live(3), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain(
      'AdminCreateUserConfig.UnusedAccountValidityDays'
    );
    expect(pathsByTier(f, 'undeclared')).not.toContain(
      'AdminCreateUserConfig.UnusedAccountValidityDays'
    );
  });
  it('surfaces an out-of-band lifetime that diverges from the declared sibling', () => {
    const f = classifyResource(mk(3), live(9), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain(
      'AdminCreateUserConfig.UnusedAccountValidityDays'
    );
  });
});

describe('#642 Cognito WebAuthnFactorConfiguration default', () => {
  const res: DesiredResource = {
    logicalId: 'Pool',
    resourceType: 'AWS::Cognito::UserPool',
    physicalId: 'pool',
    declared: { MfaConfiguration: 'OFF' },
  };
  it('folds SINGLE_FACTOR to atDefault', () => {
    const f = classifyResource(res, { WebAuthnFactorConfiguration: 'SINGLE_FACTOR' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('WebAuthnFactorConfiguration');
  });
  it('surfaces MULTI_FACTOR as undeclared', () => {
    const f = classifyResource(res, { WebAuthnFactorConfiguration: 'MULTI_FACTOR' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('WebAuthnFactorConfiguration');
  });
});

describe('#642 Batch JobQueueType (createOnly, derived from the attached CE)', () => {
  const res: DesiredResource = {
    logicalId: 'Queue',
    resourceType: 'AWS::Batch::JobQueue',
    physicalId: 'queue',
    declared: { Priority: 1, State: 'ENABLED' },
  };
  it('folds any AWS-derived queue type value-independent (undeclared + immutable)', () => {
    for (const t of ['ECS_FARGATE', 'ECS', 'EKS']) {
      const f = classifyResource(res, { JobQueueType: t }, emptySchema);
      expect(pathsByTier(f, 'atDefault')).toContain('JobQueueType');
      expect(pathsByTier(f, 'undeclared')).not.toContain('JobQueueType');
    }
  });
});

describe('#643 ECR RepositoryCreationTemplate constant defaults', () => {
  const res: DesiredResource = {
    logicalId: 'Rct',
    resourceType: 'AWS::ECR::RepositoryCreationTemplate',
    physicalId: 'rct',
    declared: { Prefix: 'p', AppliedFor: ['PULL_THROUGH_CACHE'] },
  };
  it('folds AES256 encryption + MUTABLE tags to atDefault', () => {
    const f = classifyResource(
      res,
      { EncryptionConfiguration: { EncryptionType: 'AES256' }, ImageTagMutability: 'MUTABLE' },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['EncryptionConfiguration', 'ImageTagMutability'])
    );
  });
  it('surfaces IMMUTABLE tags as undeclared', () => {
    const f = classifyResource(res, { ImageTagMutability: 'IMMUTABLE' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('ImageTagMutability');
  });
});

describe('#643 SSM ResourceDataSync S3Destination top-level twins + SyncType', () => {
  const res: DesiredResource = {
    logicalId: 'Sync',
    resourceType: 'AWS::SSM::ResourceDataSync',
    physicalId: 'sync',
    declared: {
      S3Destination: { BucketName: 'b', BucketRegion: 'us-east-1', SyncFormat: 'JsonSerDe' },
    },
  };
  it('folds the top-level twins against the declared S3Destination sibling + SyncType constant', () => {
    const f = classifyResource(
      res,
      {
        S3Destination: { BucketName: 'b', BucketRegion: 'us-east-1', SyncFormat: 'JsonSerDe' },
        BucketName: 'b',
        BucketRegion: 'us-east-1',
        SyncFormat: 'JsonSerDe',
        SyncType: 'SyncToDestination',
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['BucketName', 'BucketRegion', 'SyncFormat', 'SyncType'])
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
  it('surfaces a top-level twin retargeted to a different bucket', () => {
    const f = classifyResource(
      res,
      {
        S3Destination: { BucketName: 'b', BucketRegion: 'us-east-1', SyncFormat: 'JsonSerDe' },
        BucketName: 'other',
        BucketRegion: 'us-east-1',
        SyncFormat: 'JsonSerDe',
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('BucketName');
  });
});

describe('#668 CloudFront GeoRestriction.Locations is an unordered set', () => {
  const res: DesiredResource = {
    logicalId: 'Dist',
    resourceType: 'AWS::CloudFront::Distribution',
    physicalId: 'dist',
    declared: {
      DistributionConfig: {
        Restrictions: { GeoRestriction: { RestrictionType: 'whitelist', Locations: ['US', 'JP'] } },
      },
    },
  };
  it('does not false-drift on a propagation reorder of the same country set', () => {
    const f = classifyResource(
      res,
      {
        DistributionConfig: {
          Restrictions: {
            GeoRestriction: { RestrictionType: 'whitelist', Locations: ['JP', 'US'] },
          },
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).not.toContain(
      'DistributionConfig.Restrictions.GeoRestriction.Locations'
    );
  });
  it('still surfaces a genuine membership change as declared drift', () => {
    const f = classifyResource(
      res,
      {
        DistributionConfig: {
          Restrictions: {
            GeoRestriction: { RestrictionType: 'whitelist', Locations: ['US', 'GB'] },
          },
        },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toContain(
      'DistributionConfig.Restrictions.GeoRestriction.Locations'
    );
  });
});

describe('#678 PRIVATE RestApi derives TLS_1_2 + dualstack from the declared endpoint type', () => {
  const mk = (types: string[]): DesiredResource => ({
    logicalId: 'Api',
    resourceType: 'AWS::ApiGateway::RestApi',
    physicalId: 'api',
    declared: { Name: 'api', EndpointConfiguration: { Types: types } },
  });
  it('folds a PRIVATE api SecurityPolicy=TLS_1_2 + IpAddressType=dualstack', () => {
    const f = classifyResource(
      mk(['PRIVATE']),
      {
        SecurityPolicy: 'TLS_1_2',
        EndpointConfiguration: { Types: ['PRIVATE'], IpAddressType: 'dualstack' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['SecurityPolicy', 'EndpointConfiguration.IpAddressType'])
    );
  });
  it('still surfaces a PRIVATE api whose SecurityPolicy was flipped away from TLS_1_2', () => {
    const f = classifyResource(
      mk(['PRIVATE']),
      {
        SecurityPolicy: 'TLS_1_0',
        EndpointConfiguration: { Types: ['PRIVATE'], IpAddressType: 'dualstack' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('SecurityPolicy');
  });
  it('keeps the EDGE/REGIONAL constants: TLS_1_0 folds, TLS_1_2 surfaces', () => {
    const folds = classifyResource(
      mk(['REGIONAL']),
      {
        SecurityPolicy: 'TLS_1_0',
        EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'ipv4' },
      },
      emptySchema
    );
    expect(pathsByTier(folds, 'atDefault')).toContain('SecurityPolicy');
    const surfaces = classifyResource(
      mk(['REGIONAL']),
      {
        SecurityPolicy: 'TLS_1_2',
        EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'ipv4' },
      },
      emptySchema
    );
    expect(pathsByTier(surfaces, 'undeclared')).toContain('SecurityPolicy');
  });
});

describe('#847 AutoScaling ScheduledAction StartTime / EndTime (undeclared, time-varying)', () => {
  const res: DesiredResource = {
    logicalId: 'Schedule',
    resourceType: 'AWS::AutoScaling::ScheduledAction',
    physicalId: 'CdkRea-Sched-Y8TVCVCJA9P3',
    declared: {
      AutoScalingGroupName: 'Asg',
      DesiredCapacity: 1,
      MaxSize: 2,
      MinSize: 1,
      Recurrence: '0 9 * * MON-FRI',
      TimeZone: 'UTC',
    },
  };
  it('folds the AWS-computed next-occurrence StartTime value-independent', () => {
    // Time-varying: each read yields a fresh next-occurrence, so any value must fold.
    for (const t of ['2026-06-22T09:00:00Z', '2026-07-13T09:00:00Z']) {
      const f = classifyResource(res, { StartTime: t }, emptySchema);
      expect(pathsByTier(f, 'atDefault')).toContain('StartTime');
      expect(pathsByTier(f, 'undeclared')).not.toContain('StartTime');
    }
  });
  it('folds the serialized-null EndTime="null" artifact', () => {
    const f = classifyResource(res, { EndTime: 'null' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('EndTime');
    expect(pathsByTier(f, 'undeclared')).not.toContain('EndTime');
  });
});

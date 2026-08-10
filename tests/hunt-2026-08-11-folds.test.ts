// 2026-08-11 hunt regressions:
//  - #1750: RDS GlobalCluster stores GlobalClusterIdentifier lowercased while the CC
//    handler accepts mixed case (live CC probe: `CdkrdHunt-Mixed-GC` stored as
//    `cdkrdhunt-mixed-gc`) — declared-side case tolerance on the owning prop, plus the
//    #1712-class consumer echo on a member DBCluster's GlobalClusterIdentifier.
//  - #1751: linkpack-hunt first-run FPs — ECS ClusterCapacityProviderAssociations echoes
//    CapacityProviders sorted; AppSync DataSource materializes MetricsConfig "DISABLED"
//    and SourceApiAssociation {MergeType: MANUAL_MERGE} undeclared; a headless RDS
//    GlobalCluster reads back the current GA EngineVersion undeclared.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding, SchemaInfo } from '../src/types.js';

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

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();

describe('#1750 RDS GlobalCluster mixed-case identifier folds', () => {
  it('owning GlobalClusterIdentifier + Engine: case-only echoes fold', () => {
    const findings = classifyResource(
      {
        logicalId: 'GC',
        resourceType: 'AWS::RDS::GlobalCluster',
        physicalId: 'CdkrdHunt-Mixed-GC',
        declared: { GlobalClusterIdentifier: 'CdkrdHunt-Mixed-GC', Engine: 'Aurora-PostgreSQL' },
      },
      { GlobalClusterIdentifier: 'cdkrdhunt-mixed-gc', Engine: 'aurora-postgresql' },
      emptySchema
    );
    expect(findings.filter((f: Finding) => f.tier === 'declared')).toEqual([]);
  });

  it('consumer DBCluster.GlobalClusterIdentifier: stored-lowercase echo folds', () => {
    const findings = classifyResource(
      {
        logicalId: 'Member',
        resourceType: 'AWS::RDS::DBCluster',
        physicalId: 'member-cl',
        declared: {
          DBClusterIdentifier: 'member-cl',
          Engine: 'aurora-postgresql',
          GlobalClusterIdentifier: 'CdkrdHunt-Mixed-GC',
        },
      },
      {
        DBClusterIdentifier: 'member-cl',
        Engine: 'aurora-postgresql',
        GlobalClusterIdentifier: 'cdkrdhunt-mixed-gc',
      },
      emptySchema
    );
    expect(findings.filter((f: Finding) => f.tier === 'declared')).toEqual([]);
  });

  it('undeclared GA EngineVersion on a headless GlobalCluster folds value-independent, declared stays compared (#1751)', () => {
    const clean = classifyResource(
      {
        logicalId: 'GC',
        resourceType: 'AWS::RDS::GlobalCluster',
        physicalId: 'gc',
        declared: { GlobalClusterIdentifier: 'gc', Engine: 'aurora-postgresql' },
      },
      { GlobalClusterIdentifier: 'gc', Engine: 'aurora-postgresql', EngineVersion: '17.7' },
      emptySchema
    );
    expect(tierPaths(clean)).toEqual(['atDefault:EngineVersion']);

    const declaredMismatch = classifyResource(
      {
        logicalId: 'GC',
        resourceType: 'AWS::RDS::GlobalCluster',
        physicalId: 'gc',
        declared: {
          GlobalClusterIdentifier: 'gc',
          Engine: 'aurora-postgresql',
          EngineVersion: '16.4',
        },
      },
      { GlobalClusterIdentifier: 'gc', Engine: 'aurora-postgresql', EngineVersion: '17.7' },
      emptySchema
    );
    expect(tierPaths(declaredMismatch)).toEqual(['declared:EngineVersion']);
  });

  it('a real global-cluster reassignment (beyond case) still surfaces', () => {
    const findings = classifyResource(
      {
        logicalId: 'GC',
        resourceType: 'AWS::RDS::GlobalCluster',
        physicalId: 'gc-a',
        declared: { GlobalClusterIdentifier: 'gc-a', Engine: 'aurora-postgresql' },
      },
      { GlobalClusterIdentifier: 'gc-b', Engine: 'aurora-postgresql' },
      emptySchema
    );
    expect(findings.filter((f: Finding) => f.tier === 'declared').map((f) => f.path)).toEqual([
      'GlobalClusterIdentifier',
    ]);
  });
});

describe('#1751 ECS ClusterCapacityProviderAssociations CapacityProviders reorder', () => {
  const base = {
    logicalId: 'Ccpa',
    resourceType: 'AWS::ECS::ClusterCapacityProviderAssociations',
    physicalId: 'cdkrd-hunt-ccpa',
  };
  it('the sorted live echo of the declared set folds', () => {
    const findings = classifyResource(
      {
        ...base,
        declared: {
          Cluster: 'cdkrd-hunt-ccpa',
          CapacityProviders: ['FARGATE_SPOT', 'FARGATE'],
          DefaultCapacityProviderStrategy: [],
        },
      },
      {
        Cluster: 'cdkrd-hunt-ccpa',
        CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
        DefaultCapacityProviderStrategy: [],
      },
      emptySchema
    );
    expect(tierPaths(findings)).toEqual([]);
  });
  it('a multiset change (provider removed out of band) still surfaces', () => {
    const findings = classifyResource(
      {
        ...base,
        declared: {
          Cluster: 'cdkrd-hunt-ccpa',
          CapacityProviders: ['FARGATE_SPOT', 'FARGATE'],
          DefaultCapacityProviderStrategy: [],
        },
      },
      {
        Cluster: 'cdkrd-hunt-ccpa',
        CapacityProviders: ['FARGATE'],
        DefaultCapacityProviderStrategy: [],
      },
      emptySchema
    );
    expect(tierPaths(findings)).toEqual(['declared:CapacityProviders']);
  });
});

describe('#1753 barest5 first-run folds', () => {
  it('ServerlessCache barest: space-Description / GA major / default SG+subnets fold; swaps surface', () => {
    const resource = {
      logicalId: 'RedisServerless',
      resourceType: 'AWS::ElastiCache::ServerlessCache',
      physicalId: 'cdkrd-hunt-0811-redis',
      declared: { Engine: 'redis', ServerlessCacheName: 'cdkrd-hunt-0811-redis' },
    };
    const opts = {
      defaultSgIds: new Set(['sg-0a26e23e2310ee0c9']),
      defaultSubnetIds: new Set(['subnet-a', 'subnet-b', 'subnet-c']),
    };
    const clean = classifyResource(
      resource,
      {
        Engine: 'redis',
        ServerlessCacheName: 'cdkrd-hunt-0811-redis',
        Description: ' ',
        MajorEngineVersion: '7',
        SecurityGroupIds: ['sg-0a26e23e2310ee0c9'],
        SubnetIds: ['subnet-a', 'subnet-b', 'subnet-c'],
      },
      emptySchema,
      opts
    );
    expect(tierPaths(clean)).toEqual([
      'atDefault:Description',
      'atDefault:MajorEngineVersion',
      'atDefault:SecurityGroupIds',
      'atDefault:SubnetIds',
    ]);

    const swapped = classifyResource(
      resource,
      {
        Engine: 'redis',
        ServerlessCacheName: 'cdkrd-hunt-0811-redis',
        Description: 'set out of band',
        MajorEngineVersion: '7',
        SecurityGroupIds: ['sg-rogue'],
        SubnetIds: ['subnet-a', 'subnet-rogue'],
      },
      emptySchema,
      opts
    );
    expect(tierPaths(swapped)).toEqual([
      'atDefault:MajorEngineVersion',
      'undeclared:Description',
      'undeclared:SecurityGroupIds',
      'undeclared:SubnetIds',
    ]);
  });

  it('Transfer Server zero-prop trio folds; an OOB protocol append surfaces', () => {
    const resource = {
      logicalId: 'TransferBarest',
      resourceType: 'AWS::Transfer::Server',
      physicalId: 's-123',
      declared: {},
    };
    const clean = classifyResource(
      resource,
      { Protocols: ['SFTP'], EndpointType: 'PUBLIC', IdentityProviderType: 'SERVICE_MANAGED' },
      emptySchema
    );
    expect(tierPaths(clean)).toEqual([
      'atDefault:EndpointType',
      'atDefault:IdentityProviderType',
      'atDefault:Protocols',
    ]);

    const appended = classifyResource(
      resource,
      {
        Protocols: ['SFTP', 'FTPS'],
        EndpointType: 'PUBLIC',
        IdentityProviderType: 'SERVICE_MANAGED',
      },
      emptySchema
    );
    expect(tierPaths(appended)).toEqual([
      'atDefault:EndpointType',
      'atDefault:IdentityProviderType',
      'undeclared:Protocols',
    ]);
  });

  it('Cognito SAML IdP metadata-computed enrichments fold value-independent', () => {
    const findings = classifyResource(
      {
        logicalId: 'SamlIdp',
        resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
        physicalId: 'pool|cdkrd-hunt-saml',
        declared: {
          UserPoolId: 'pool',
          ProviderName: 'cdkrd-hunt-saml',
          ProviderType: 'SAML',
          ProviderDetails: { MetadataFile: '<EntityDescriptor .../>' },
        },
      },
      {
        UserPoolId: 'pool',
        ProviderName: 'cdkrd-hunt-saml',
        ProviderType: 'SAML',
        ProviderDetails: {
          MetadataFile: '<EntityDescriptor .../>',
          SSORedirectBindingURI: 'https://example.com/sso',
          SLORedirectBindingURI: 'https://example.com/slo',
          ActiveEncryptionCertificate: 'MIICvDCC…',
        },
      },
      emptySchema
    );
    expect(tierPaths(findings)).toEqual([
      'atDefault:ProviderDetails.ActiveEncryptionCertificate',
      'atDefault:ProviderDetails.SLORedirectBindingURI',
      'atDefault:ProviderDetails.SSORedirectBindingURI',
    ]);
  });
});

describe('#1751 AppSync undeclared creation defaults fold', () => {
  it('DataSource MetricsConfig "DISABLED" folds atDefault; an OOB "ENABLED" surfaces', () => {
    const base = {
      logicalId: 'SrcDs',
      resourceType: 'AWS::AppSync::DataSource',
      physicalId: 'ds',
      declared: { ApiId: 'api', Name: 'NoneDs', Type: 'NONE' },
    };
    const clean = classifyResource(
      base,
      { ApiId: 'api', Name: 'NoneDs', Type: 'NONE', MetricsConfig: 'DISABLED' },
      emptySchema
    );
    expect(tierPaths(clean)).toEqual(['atDefault:MetricsConfig']);

    const flipped = classifyResource(
      base,
      { ApiId: 'api', Name: 'NoneDs', Type: 'NONE', MetricsConfig: 'ENABLED' },
      emptySchema
    );
    expect(tierPaths(flipped)).toEqual(['undeclared:MetricsConfig']);
  });

  it('SourceApiAssociation {MergeType: MANUAL_MERGE} folds; an OOB AUTO_MERGE switch surfaces', () => {
    const base = {
      logicalId: 'SrcAssoc',
      resourceType: 'AWS::AppSync::SourceApiAssociation',
      physicalId: 'assoc',
      declared: { MergedApiIdentifier: 'm', SourceApiIdentifier: 's' },
    };
    const clean = classifyResource(
      base,
      {
        MergedApiIdentifier: 'm',
        SourceApiIdentifier: 's',
        SourceApiAssociationConfig: { MergeType: 'MANUAL_MERGE' },
      },
      emptySchema
    );
    expect(tierPaths(clean)).toEqual(['atDefault:SourceApiAssociationConfig']);

    const flipped = classifyResource(
      base,
      {
        MergedApiIdentifier: 'm',
        SourceApiIdentifier: 's',
        SourceApiAssociationConfig: { MergeType: 'AUTO_MERGE' },
      },
      emptySchema
    );
    expect(tierPaths(flipped)).toEqual(['undeclared:SourceApiAssociationConfig']);
  });
});

// The real live Features echo shape from the 2026-08-11 stackless probe detector —
// EKS_RUNTIME_MONITORING (deprecated alias) at index 6, RUNTIME_MONITORING at index 8.
const GD_FEATURES = [
  { Name: 'S3_DATA_EVENTS', Status: 'DISABLED' },
  { Name: 'EKS_AUDIT_LOGS', Status: 'ENABLED' },
  { Name: 'EBS_MALWARE_PROTECTION', Status: 'ENABLED' },
  { Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' },
  { Name: 'AI_PROTECTION', Status: 'DISABLED' },
  { Name: 'AI_ANALYST', Status: 'DISABLED' },
  { Name: 'EKS_RUNTIME_MONITORING', Status: 'DISABLED' },
  { Name: 'LAMBDA_NETWORK_LOGS', Status: 'ENABLED' },
  { Name: 'RUNTIME_MONITORING', Status: 'DISABLED' },
];

describe('#1752 GuardDuty Detector patch shape', () => {
  const live = {
    Enable: true,
    FindingPublishingFrequency: 'SIX_HOURS',
    DataSources: {
      S3Logs: { Enable: false },
      Kubernetes: { AuditLogs: { Enable: true } },
      MalwareProtection: { ScanEc2InstanceWithFindings: { EbsVolumes: true } },
    },
    Features: GD_FEATURES,
  };

  it('translates a DataSources revert to the Features Status write + both exclusivity companions', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Detector',
      resourceType: 'AWS::GuardDuty::Detector',
      physicalId: 'd-123',
      path: 'DataSources.S3Logs',
      actual: { Enable: false },
      desired: { Enable: true },
    };
    const plan = buildRevertPlan([f], undefined, {
      liveByLogical: new Map([['Detector', live]]) as never,
    });
    expect(plan.notRevertable).toEqual([]);
    const ops = plan.items[0]!.ops;
    // the real op: the S3Logs toggle written on the Features side (S3_DATA_EVENTS, idx 0)
    const statusWrite = ops.find((o) => o.path === '/Features/0/Status');
    expect(statusWrite).toBeDefined();
    expect(statusWrite!.op).toBe('add');
    expect(statusWrite!.value).toBe('ENABLED');
    expect(statusWrite!.contract).toBeUndefined();
    // no op may still target the DataSources side (the handler rejects any such write)
    expect(ops.some((o) => o.path.startsWith('/DataSources/'))).toBe(false);
    // leg 2: the DataSources projection is stripped from the write model (contract)
    const dsRemove = ops.find((o) => o.op === 'remove' && o.path === '/DataSources');
    expect(dsRemove?.contract).toBe(true);
    // leg 1: the deprecated alias element is stripped LAST (contract, index intact)
    expect(ops[ops.length - 1]).toMatchObject({
      op: 'remove',
      path: '/Features/6',
      contract: true,
    });
  });

  it('a non-DataSources revert still carries both companions (any patch is rejected without them)', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Detector',
      resourceType: 'AWS::GuardDuty::Detector',
      physicalId: 'd-123',
      path: 'FindingPublishingFrequency',
      actual: 'SIX_HOURS',
      desired: 'FIFTEEN_MINUTES',
    };
    const plan = buildRevertPlan([f], undefined, {
      liveByLogical: new Map([['Detector', live]]) as never,
    });
    const ops = plan.items[0]!.ops;
    expect(ops.some((o) => o.path === '/FindingPublishingFrequency')).toBe(true);
    expect(ops.some((o) => o.op === 'remove' && o.path === '/DataSources' && o.contract)).toBe(
      true
    );
    expect(ops.some((o) => o.op === 'remove' && o.path === '/Features/6' && o.contract)).toBe(true);
  });

  it('no deprecated-alias companion when the echo carries only RUNTIME_MONITORING', () => {
    const modern = {
      ...live,
      Features: GD_FEATURES.filter((f) => f.Name !== 'EKS_RUNTIME_MONITORING'),
    };
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Detector',
      resourceType: 'AWS::GuardDuty::Detector',
      physicalId: 'd-123',
      path: 'FindingPublishingFrequency',
      actual: 'SIX_HOURS',
      desired: 'FIFTEEN_MINUTES',
    };
    const plan = buildRevertPlan([f], undefined, {
      liveByLogical: new Map([['Detector', modern]]) as never,
    });
    const ops = plan.items[0]!.ops;
    expect(ops.some((o) => o.path.startsWith('/Features/') && o.op === 'remove')).toBe(false);
    expect(ops.some((o) => o.op === 'remove' && o.path === '/DataSources' && o.contract)).toBe(
      true
    );
  });
});

describe('#1754 barest5 stack-B first-run folds', () => {
  it('EFS AccessPoint materialized RootDirectory {Path:"/"} folds; a re-point surfaces', () => {
    const resource = {
      logicalId: 'Ap',
      resourceType: 'AWS::EFS::AccessPoint',
      physicalId: 'fsap-1',
      declared: { FileSystemId: 'fs-1' },
    };
    const clean = classifyResource(
      resource,
      { FileSystemId: 'fs-1', RootDirectory: { Path: '/' } },
      emptySchema
    );
    expect(tierPaths(clean)).toEqual(['atDefault:RootDirectory']);

    const repointed = classifyResource(
      resource,
      { FileSystemId: 'fs-1', RootDirectory: { Path: '/data' } },
      emptySchema
    );
    expect(tierPaths(repointed)).toEqual(['undeclared:RootDirectory']);
  });

  it('KMS ReplicaKey Enabled=true folds; an out-of-band disable STILL surfaces (off-flip gate)', () => {
    const resource = {
      logicalId: 'ReplicaKey',
      resourceType: 'AWS::KMS::ReplicaKey',
      physicalId: 'mrk-1',
      declared: { PrimaryKeyArn: 'arn:aws:kms:us-west-2:111111111111:key/mrk-1' },
    };
    const clean = classifyResource(
      resource,
      { PrimaryKeyArn: 'arn:aws:kms:us-west-2:111111111111:key/mrk-1', Enabled: true },
      emptySchema
    );
    expect(tierPaths(clean)).toEqual(['atDefault:Enabled']);

    const disabled = classifyResource(
      resource,
      { PrimaryKeyArn: 'arn:aws:kms:us-west-2:111111111111:key/mrk-1', Enabled: false },
      emptySchema
    );
    expect(tierPaths(disabled)).toEqual(['undeclared:Enabled']);
  });
});

describe('#1753 ServerlessCache Description revert set-default', () => {
  it('reverts an out-of-band description via an explicit add of the one-space default (bare remove no-ops live)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'RedisServerless',
      resourceType: 'AWS::ElastiCache::ServerlessCache',
      physicalId: 'cdkrd-hunt-0811-redis',
      path: 'Description',
      actual: 'oob description',
    };
    const plan = buildRevertPlan([f], undefined, {});
    expect(plan.notRevertable).toEqual([]);
    const op = plan.items[0]!.ops.find((o) => o.path === '/Description')!;
    expect(op.op).toBe('add');
    expect(op.value).toBe(' ');
  });
});

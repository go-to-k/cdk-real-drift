// #1490 / #1491 — live-hunt first-run folds (2026-07-12 minimal-deploy sweep).
//   #1490 AWS::DMS::Endpoint (barest mysql source endpoint):
//     F1 EndpointIdentifier — DMS stores the identifier LOWERCASED, so a mixed-case
//        declaration false-flagged declared drift that SURVIVED record →
//        CASE_INSENSITIVE_PATHS entry (a genuinely different identifier still surfaces).
//     F2 SslMode — every engine's constant creation default is "none" →
//        KNOWN_DEFAULTS tier-1 pin (an out-of-band verify-full flip surfaces).
//     F3 KmsKeyId — the AWS-managed `aws/dms` key ARN materialized when no key is
//        declared → VALUE_INDEPENDENT (the #533 AWS-assigned-KmsKeyId class).
//   #1491 AWS::ECS::Cluster:
//     CapacityProviders — ECS reads the attachment list back SORTED (a set), so a
//     non-sorted declaration false-flagged declared drift that survived record →
//     UNORDERED_ARRAY_PROPS entry (a genuine attach/detach still surfaces).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const dmsSchema: SchemaInfo = {
  readOnly: new Set(['ExternalId']),
  writeOnly: new Set(['Password']),
  createOnly: new Set(['KmsKeyId']),
  readOnlyPaths: ['ExternalId'],
  writeOnlyPaths: ['Password'],
  createOnlyPaths: ['KmsKeyId'],
  defaults: {},
  defaultPaths: {},
};

const mkDms = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntDmsEndpoint',
  resourceType: 'AWS::DMS::Endpoint',
  physicalId: 'arn:aws:dms:us-east-1:123456789012:endpoint:ABC123',
  declared,
});

const dmsDeclared = {
  EndpointIdentifier: 'CdkrdHunt-Mixed-DMS-EP',
  EndpointType: 'source',
  EngineName: 'mysql',
  ServerName: 'hunt.invalid',
  Port: 3306,
  Username: 'hunter',
};

// What the live read of the fresh, un-mutated endpoint materializes (case-idents-min).
const dmsLive = {
  EndpointIdentifier: 'cdkrdhunt-mixed-dms-ep',
  EndpointType: 'SOURCE',
  EngineName: 'mysql',
  ServerName: 'hunt.invalid',
  Port: 3306,
  Username: 'hunter',
  SslMode: 'none',
  KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/8b0bca8d-7f3f-4f19-bebf-bf6c72f3f1e6',
};

describe('#1490 DMS Endpoint first-run folds', () => {
  it('a fresh minimal endpoint classifies with ZERO declared and ZERO undeclared findings', () => {
    const findings = classifyResource(mkDms(dmsDeclared), dmsLive, dmsSchema);
    // Full-tier assertion (not a filtered subset): the first-run invariant is zero
    // surfaced drift; the AWS-assigned values land in atDefault, nothing else.
    expect(tier(findings, 'declared')).toEqual([]);
    expect(tier(findings, 'undeclared')).toEqual([]);
    expect(tier(findings, 'atDefault')).toEqual(['KmsKeyId', 'SslMode']);
  });

  it('F1 a genuinely DIFFERENT EndpointIdentifier still surfaces as declared drift', () => {
    const findings = classifyResource(
      mkDms(dmsDeclared),
      { ...dmsLive, EndpointIdentifier: 'someone-renamed-this' },
      dmsSchema
    );
    expect(tier(findings, 'declared')).toEqual(['EndpointIdentifier']);
  });

  it('F2 an out-of-band SslMode hardening no longer matches the "none" default and surfaces', () => {
    const findings = classifyResource(
      mkDms(dmsDeclared),
      { ...dmsLive, SslMode: 'verify-full' },
      dmsSchema
    );
    expect(tier(findings, 'undeclared')).toEqual(['SslMode']);
    expect(tier(findings, 'atDefault')).toEqual(['KmsKeyId']);
  });

  it('F2 a DECLARED SslMode diverging live is compared in the declared loop (detection kept)', () => {
    const findings = classifyResource(
      mkDms({ ...dmsDeclared, SslMode: 'require' }),
      dmsLive, // live still "none"
      dmsSchema
    );
    expect(tier(findings, 'declared')).toEqual(['SslMode']);
  });
});

const rdsSchema: SchemaInfo = {
  readOnly: new Set(['Endpoint']),
  writeOnly: new Set(['MasterUserPassword']),
  createOnly: new Set(['Engine']),
  readOnlyPaths: ['Endpoint'],
  writeOnlyPaths: ['MasterUserPassword'],
  createOnlyPaths: ['Engine'],
  defaults: {},
  defaultPaths: {},
};

describe('2026-07-12 hunt: RDS minimal-deploy first-run folds', () => {
  it('DBInstance undeclared DBSubnetGroupName "default" folds atDefault; a custom group surfaces', () => {
    const mk = (live: Record<string, unknown>) =>
      classifyResource(
        {
          logicalId: 'HuntPostgres',
          resourceType: 'AWS::RDS::DBInstance',
          physicalId: 'huntpostgres',
          declared: { Engine: 'postgres', DBInstanceClass: 'db.t3.micro' },
        },
        { Engine: 'postgres', DBInstanceClass: 'db.t3.micro', ...live },
        rdsSchema
      );
    expect(tier(mk({ DBSubnetGroupName: 'default' }), 'atDefault')).toContain('DBSubnetGroupName');
    expect(tier(mk({ DBSubnetGroupName: 'default' }), 'undeclared')).toEqual([]);
    // an out-of-band re-placement into a custom group no longer matches — detection kept
    expect(tier(mk({ DBSubnetGroupName: 'ops-moved-me' }), 'undeclared')).toEqual([
      'DBSubnetGroupName',
    ]);
  });

  it('DBInstance sqlserver arms: LicenseModel + CharacterSetName fold; a divergence surfaces', () => {
    const mk = (live: Record<string, unknown>) =>
      classifyResource(
        {
          logicalId: 'HuntSqlServer',
          resourceType: 'AWS::RDS::DBInstance',
          physicalId: 'huntsqlserver',
          declared: { Engine: 'sqlserver-ex', DBInstanceClass: 'db.t3.micro' },
        },
        { Engine: 'sqlserver-ex', DBInstanceClass: 'db.t3.micro', ...live },
        rdsSchema
      );
    const clean = mk({
      LicenseModel: 'license-included',
      CharacterSetName: 'SQL_Latin1_General_CP1_CI_AS',
    });
    expect(tier(clean, 'undeclared')).toEqual([]);
    expect(tier(clean, 'atDefault')).toEqual(['CharacterSetName', 'LicenseModel']);
    // a non-default collation (an era/creation divergence) still surfaces
    expect(tier(mk({ CharacterSetName: 'Latin1_General_100_CS_AS' }), 'undeclared')).toEqual([
      'CharacterSetName',
    ]);
  });

  it('DBCluster undeclared default.<family> parameter group folds; a custom group surfaces', () => {
    const mk = (live: Record<string, unknown>) =>
      classifyResource(
        {
          logicalId: 'HuntAuroraPg',
          resourceType: 'AWS::RDS::DBCluster',
          physicalId: 'huntaurorapg',
          declared: { Engine: 'aurora-postgresql' },
        },
        { Engine: 'aurora-postgresql', ...live },
        rdsSchema
      );
    expect(
      tier(mk({ DBClusterParameterGroupName: 'default.aurora-postgresql17' }), 'atDefault')
    ).toContain('DBClusterParameterGroupName');
    expect(
      tier(mk({ DBClusterParameterGroupName: 'default.aurora-postgresql17' }), 'undeclared')
    ).toEqual([]);
    expect(tier(mk({ DBClusterParameterGroupName: 'my-custom-pg' }), 'undeclared')).toEqual([
      'DBClusterParameterGroupName',
    ]);
  });
});

describe('#1495 StackSet SELF_MANAGED conventional-role folds', () => {
  const ssSchema: SchemaInfo = {
    readOnly: new Set(['StackSetId']),
    writeOnly: new Set(['TemplateBody']),
    createOnly: new Set(['StackSetName', 'PermissionModel']),
    readOnlyPaths: ['StackSetId'],
    writeOnlyPaths: ['TemplateBody'],
    createOnlyPaths: ['StackSetName', 'PermissionModel'],
    defaults: {},
    defaultPaths: {},
  };
  const mk = (live: Record<string, unknown>) =>
    classifyResource(
      {
        logicalId: 'HuntStackSet',
        resourceType: 'AWS::CloudFormation::StackSet',
        physicalId: 'cdkrd-hunt-stackset:abc',
        declared: { StackSetName: 'cdkrd-hunt-stackset', PermissionModel: 'SELF_MANAGED' },
      },
      { StackSetName: 'cdkrd-hunt-stackset', PermissionModel: 'SELF_MANAGED', ...live },
      ssSchema,
      // CONTEXT_ARN_DEFAULTS substitutes {partition}/{accountId} from the check context
      { region: 'us-east-1', accountId: '123456789012' }
    );

  it('folds the conventional admin-role ARN (any account) + execution-role name to atDefault', () => {
    const findings = mk({
      AdministrationRoleARN:
        'arn:aws:iam::123456789012:role/AWSCloudFormationStackSetAdministrationRole',
      ExecutionRoleName: 'AWSCloudFormationStackSetExecutionRole',
    });
    expect(tier(findings, 'undeclared')).toEqual([]);
    expect(tier(findings, 'atDefault')).toEqual(['AdministrationRoleARN', 'ExecutionRoleName']);
  });

  it('surfaces a CUSTOM admin role / execution role — detection preserved', () => {
    const findings = mk({
      AdministrationRoleARN: 'arn:aws:iam::123456789012:role/OpsCustomStackSetAdmin',
      ExecutionRoleName: 'OpsCustomExecRole',
    });
    expect(tier(findings, 'undeclared')).toEqual(['AdministrationRoleARN', 'ExecutionRoleName']);
  });

  it('surfaces the conventional role name in a DIFFERENT account (cross-account) — own-account gate', () => {
    const findings = mk({
      AdministrationRoleARN:
        'arn:aws:iam::999999999999:role/AWSCloudFormationStackSetAdministrationRole',
    });
    expect(tier(findings, 'undeclared')).toEqual(['AdministrationRoleARN']);
  });
});

describe('2026-07-12 hunt: Batch ComputeEnvironment first-run folds', () => {
  const batchSchema: SchemaInfo = {
    readOnly: new Set(['ComputeEnvironmentArn']),
    writeOnly: new Set(),
    createOnly: new Set(['Type']),
    readOnlyPaths: ['ComputeEnvironmentArn'],
    writeOnlyPaths: [],
    createOnlyPaths: ['Type'],
    defaults: {},
    defaultPaths: {},
  };
  const declared = {
    Type: 'MANAGED',
    ComputeResources: {
      Type: 'EC2',
      MaxvCpus: 4,
      MinvCpus: 0,
      InstanceTypes: ['m5.large'],
      Subnets: ['subnet-1'],
    },
  };
  const mk = (live: Record<string, unknown>) =>
    classifyResource(
      {
        logicalId: 'HuntEc2Ce',
        resourceType: 'AWS::Batch::ComputeEnvironment',
        physicalId: 'arn:aws:batch:us-east-1:123456789012:compute-environment/x',
        declared,
      },
      { ...declared, ...live },
      batchSchema
    );

  it('folds undeclared State=ENABLED and the era Ec2Configuration image types', () => {
    for (const imageType of ['ECS_AL2023', 'ECS_AL2']) {
      const findings = mk({
        State: 'ENABLED',
        ComputeResources: {
          ...declared.ComputeResources,
          Ec2Configuration: [{ ImageType: imageType }],
        },
      });
      expect(tier(findings, 'undeclared')).toEqual([]);
    }
  });

  it('surfaces an out-of-band DISABLE and a non-default image type — detection preserved', () => {
    expect(tier(mk({ State: 'DISABLED' }), 'undeclared')).toEqual(['State']);
    const findings = mk({
      State: 'ENABLED',
      ComputeResources: {
        ...declared.ComputeResources,
        Ec2Configuration: [{ ImageType: 'ECS_AL2_NVIDIA' }],
      },
    });
    expect(tier(findings, 'undeclared')).toContain('ComputeResources.Ec2Configuration');
  });
});

describe('#1503 MemoryDB minimal valkey first-run folds', () => {
  const mdbSchema: SchemaInfo = {
    readOnly: new Set(['ARN', 'Status']),
    writeOnly: new Set(),
    createOnly: new Set(['ClusterName']),
    readOnlyPaths: ['ARN', 'Status'],
    writeOnlyPaths: [],
    createOnlyPaths: ['ClusterName'],
    defaults: {},
    defaultPaths: {},
  };
  const declared = {
    ClusterName: 'cdkrd-hunt-mdb-valkey',
    NodeType: 'db.t4g.small',
    ACLName: 'open-access',
    Engine: 'valkey',
    SubnetGroupName: 'cdkrd-hunt-mdb-valkey-sng',
  };
  const mk = (live: Record<string, unknown>) =>
    classifyResource(
      {
        logicalId: 'HuntValkeyCluster',
        resourceType: 'AWS::MemoryDB::Cluster',
        physicalId: 'cdkrd-hunt-mdb-valkey',
        declared,
      },
      { ...declared, ...live },
      mdbSchema
    );

  it('folds the engine-independent creation constants + GA EngineVersion (ZERO first-run drift)', () => {
    const findings = mk({
      NumShards: 1,
      NumReplicasPerShard: 1,
      SnapshotRetentionLimit: 0,
      TLSEnabled: true,
      EngineVersion: '7.3',
    });
    expect(tier(findings, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band reshard / snapshot enable — detection preserved', () => {
    // (TLSEnabled is create-only, so an OFF state cannot arise out of band — a TLS-off
    // cluster declares it and the declared loop compares it; no OFF-state probe here.)
    expect(tier(mk({ NumShards: 3 }), 'undeclared')).toEqual(['NumShards']);
    expect(tier(mk({ SnapshotRetentionLimit: 7 }), 'undeclared')).toEqual([
      'SnapshotRetentionLimit',
    ]);
  });
});

const ecsSchema: SchemaInfo = {
  readOnly: new Set(['Arn']),
  writeOnly: new Set(),
  createOnly: new Set(['ClusterName']),
  readOnlyPaths: ['Arn'],
  writeOnlyPaths: [],
  createOnlyPaths: ['ClusterName'],
  defaults: {},
  defaultPaths: {},
};

const mkEcs = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntEcsCluster',
  resourceType: 'AWS::ECS::Cluster',
  physicalId: 'cdkrd-hunt-reorder-cluster',
  declared,
});

describe('#1491 ECS Cluster CapacityProviders set-reorder fold', () => {
  it('an identical provider set echoed sorted is NOT declared drift (ZERO first-run drift)', () => {
    const findings = classifyResource(
      mkEcs({
        ClusterName: 'cdkrd-hunt-reorder-cluster',
        CapacityProviders: ['FARGATE_SPOT', 'FARGATE'],
      }),
      {
        ClusterName: 'cdkrd-hunt-reorder-cluster',
        CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
      },
      ecsSchema
    );
    expect(tier(findings, 'declared')).toEqual([]);
  });

  it('a genuine out-of-band provider DETACH still changes the multiset and surfaces', () => {
    const findings = classifyResource(
      mkEcs({
        ClusterName: 'cdkrd-hunt-reorder-cluster',
        CapacityProviders: ['FARGATE_SPOT', 'FARGATE'],
      }),
      {
        ClusterName: 'cdkrd-hunt-reorder-cluster',
        CapacityProviders: ['FARGATE'],
      },
      ecsSchema
    );
    expect(tier(findings, 'declared')).toEqual(['CapacityProviders']);
  });
});

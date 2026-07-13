// #1557 — a freshly deployed, un-mutated minimal DMS stack (ReplicationInstance + Endpoints +
// ReplicationTask, only required props declared) surfaced 14 [Potential Drift] entries on a first
// check. All are AWS-materialized creation defaults that must fold to zero potential drift, across
// four fold tiers. These tests pin the table entries AND prove detection is PRESERVED (an
// out-of-band change away from each folded default still surfaces). The end-to-end fold is
// additionally locked by the golden corpus cases (AWS__DMS__ReplicationInstance.HuntDmsRi etc.).
import {
  DatabaseMigrationServiceClient,
  DescribeOrderableReplicationInstancesCommand,
} from '@aws-sdk/client-database-migration-service';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource, DEFAULT_SG_LIST_PATHS } from '../src/diff/classify.js';
import { fetchDmsAllocatedStorageDefaults } from '../src/commands/gather.js';
import {
  GENERATED_TOPLEVEL_PATHS,
  KNOWN_DEFAULTS,
  VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS,
} from '../src/normalize/noise.js';
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

const byTierPath = (fs: Finding[]) => fs.map((f) => `${f.tier} ${f.path}`).sort();
const pathTier = (fs: Finding[], path: string) => fs.find((f) => f.path === path)?.tier;

// The AWS-assigned identity + defaults a fresh dms.c6i.large replication instance reads back.
const riLive = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ReplicationInstanceIdentifier: 'huntdmsri-q2z2kglbegpum1mf',
  ReplicationInstanceClass: 'dms.c6i.large',
  AllocatedStorage: 100,
  MultiAZ: false,
  EngineVersion: '3.5.4',
  AutoMinorVersionUpgrade: true,
  PubliclyAccessible: true,
  AvailabilityZone: 'us-east-1a',
  PreferredMaintenanceWindow: 'fri:08:20-fri:08:50',
  KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/8b0bca8d-7f3f-4f19-bebf-bf6c72f3f1e6',
  NetworkType: 'IPV4',
  ReplicationSubnetGroupIdentifier: 'huntdmssng-epnnheykqkgw4fho',
  VpcSecurityGroupIds: ['sg-0394d4b516f73dee8'],
  ...over,
});

const riResource: DesiredResource = {
  logicalId: 'HuntDmsRi',
  resourceType: 'AWS::DMS::ReplicationInstance',
  physicalId: 'arn:aws:dms:us-east-1:111111111111:rep:2AWWXYNVBFCVPAC4SBILMZXHCA',
  declared: {
    ReplicationInstanceClass: 'dms.c6i.large',
    ReplicationSubnetGroupIdentifier: 'huntdmssng-epnnheykqkgw4fho',
  },
};

const riOpts = {
  accountId: '111111111111',
  region: 'us-east-1',
  kmsAliasTargets: {},
  accountDefaults: { dmsAllocatedStorageDefaults: { 'dms.c6i.large': 100 } },
  defaultSgIds: new Set(['sg-0394d4b516f73dee8']),
};

describe('#1557 DMS first-run default folds', () => {
  it('table entries are present', () => {
    expect(KNOWN_DEFAULTS['AWS::DMS::ReplicationInstance']).toEqual({
      AutoMinorVersionUpgrade: true,
      PubliclyAccessible: true,
      NetworkType: 'IPV4',
    });
    expect(GENERATED_TOPLEVEL_PATHS['AWS::DMS::ReplicationInstance']).toEqual(
      new Set(['ReplicationInstanceIdentifier'])
    );
    expect(GENERATED_TOPLEVEL_PATHS['AWS::DMS::Endpoint']).toEqual(new Set(['EndpointIdentifier']));
    expect(GENERATED_TOPLEVEL_PATHS['AWS::DMS::ReplicationTask']).toEqual(
      new Set(['ReplicationTaskIdentifier'])
    );
    expect(VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::DMS::ReplicationInstance']).toEqual(
      new Set(['EngineVersion', 'AvailabilityZone', 'PreferredMaintenanceWindow', 'KmsKeyId'])
    );
    expect(VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS['AWS::DMS::ReplicationTask']).toEqual(
      new Set(['ReplicationTaskSettings'])
    );
    expect(DEFAULT_SG_LIST_PATHS['AWS::DMS::ReplicationInstance']).toBe('VpcSecurityGroupIds');
  });

  it('a clean fresh ReplicationInstance produces ZERO potential drift', () => {
    const f = classifyResource(riResource, riLive(), emptySchema, riOpts);
    expect(f.filter((x) => x.tier === 'undeclared')).toEqual([]);
    // every AWS-assigned value folds (atDefault) or is the generated identity (generated)
    expect(byTierPath(f)).toEqual([
      'atDefault AllocatedStorage',
      'atDefault AutoMinorVersionUpgrade',
      'atDefault AvailabilityZone',
      'atDefault EngineVersion',
      'atDefault KmsKeyId',
      'atDefault NetworkType',
      'atDefault PreferredMaintenanceWindow',
      'atDefault PubliclyAccessible',
      'atDefault VpcSecurityGroupIds',
      'generated ReplicationInstanceIdentifier',
    ]);
  });

  it('detection preserved: an out-of-band disable / change away from a folded default surfaces', () => {
    // AutoMinorVersionUpgrade / PubliclyAccessible OFF (MEANINGFUL_WHEN_OFF — RI has no restore source)
    const off = classifyResource(
      riResource,
      riLive({ AutoMinorVersionUpgrade: false, PubliclyAccessible: false }),
      emptySchema,
      riOpts
    );
    expect(pathTier(off, 'AutoMinorVersionUpgrade')).toBe('undeclared');
    expect(pathTier(off, 'PubliclyAccessible')).toBe('undeclared');

    // NetworkType flipped to IPV6 (equality-gated constant)
    const net = classifyResource(riResource, riLive({ NetworkType: 'DUAL' }), emptySchema, riOpts);
    expect(pathTier(net, 'NetworkType')).toBe('undeclared');

    // AllocatedStorage grown out of band (derived default — no longer == the class default 100)
    const stor = classifyResource(
      riResource,
      riLive({ AllocatedStorage: 200 }),
      emptySchema,
      riOpts
    );
    expect(pathTier(stor, 'AllocatedStorage')).toBe('undeclared');

    // A SG append (a rogue second group) surfaces; the lone default still folds
    const sg = classifyResource(
      riResource,
      riLive({ VpcSecurityGroupIds: ['sg-0394d4b516f73dee8', 'sg-rogue'] }),
      emptySchema,
      riOpts
    );
    expect(pathTier(sg, 'VpcSecurityGroupIds')).toBe('undeclared');
  });

  it('AllocatedStorage falls through to undeclared when the class default was not resolved', () => {
    // gather lookup denied/unavailable → dmsAllocatedStorageDefaults absent → no derived fold
    const f = classifyResource(riResource, riLive(), emptySchema, {
      ...riOpts,
      accountDefaults: {},
    });
    expect(pathTier(f, 'AllocatedStorage')).toBe('undeclared');
  });
});

describe('#1557 fetchDmsAllocatedStorageDefaults (live wiring)', () => {
  const dms = mockClient(DatabaseMigrationServiceClient);
  afterEach(() => dms.reset());

  it('maps each ReplicationInstanceClass to its DefaultAllocatedStorage (paginated)', async () => {
    dms
      .on(DescribeOrderableReplicationInstancesCommand)
      .resolvesOnce({
        OrderableReplicationInstances: [
          { ReplicationInstanceClass: 'dms.c6i.large', DefaultAllocatedStorage: 100 },
          { ReplicationInstanceClass: 'dms.t3.medium', DefaultAllocatedStorage: 50 },
        ],
        Marker: 'next',
      })
      .resolves({
        OrderableReplicationInstances: [
          { ReplicationInstanceClass: 'dms.r5.large', DefaultAllocatedStorage: 100 },
        ],
      });
    const m = await fetchDmsAllocatedStorageDefaults('us-west-1');
    expect(m).toEqual({
      'dms.c6i.large': 100,
      'dms.t3.medium': 50,
      'dms.r5.large': 100,
    });
  });

  it('fails open (returns {}) when the API call throws', async () => {
    dms.on(DescribeOrderableReplicationInstancesCommand).rejects(new Error('AccessDenied'));
    const m = await fetchDmsAllocatedStorageDefaults('eu-west-3');
    expect(m).toEqual({});
  });
});

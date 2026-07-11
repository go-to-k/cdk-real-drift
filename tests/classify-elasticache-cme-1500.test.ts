// #1500: ElastiCache ReplicationGroup CLUSTER-MODE-ENABLED first-run FP trio (the #1477 variant-axis
// class — every corpus RG is cluster-mode-disabled, and KNOWN_DEFAULTS pins ClusterMode:'disabled').
// A barest cluster-mode RG (numNodeGroups:2, replicasPerNodeGroup:0), first `check` (live us-east-1,
// 2026-07-12):
//   HuntCmeRg.ClusterMode                actual ="enabled"
//   HuntCmeRg.AutomaticFailoverEnabled   actual =true
//   HuntCmeRg.NumCacheClusters           actual =2
// All three are tier-2 DERIVED from the declared shard/replica shape (see
// elastiCacheReplicationGroupDerivedDefault): equality-gated against the computed value, so an
// out-of-band migration / failover flip / shard-replica scale still surfaces.
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

describe('#1500 ElastiCache::ReplicationGroup cluster-mode-enabled derived trio', () => {
  const res: DesiredResource = {
    logicalId: 'HuntCmeRg',
    resourceType: 'AWS::ElastiCache::ReplicationGroup',
    physicalId: 'huntcmerg',
    declared: {
      ReplicationGroupDescription: 'hunt cme rg',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumNodeGroups: 2,
      ReplicasPerNodeGroup: 0,
    },
  };
  // Clean live model of the fresh cluster-mode RG: the declared echoes plus the three derived
  // trio props and the already-pinned AutoMinorVersionUpgrade / IpDiscovery / NetworkType defaults.
  const cleanLive = {
    ReplicationGroupDescription: 'hunt cme rg',
    Engine: 'redis',
    CacheNodeType: 'cache.t4g.micro',
    NumNodeGroups: 2,
    ReplicasPerNodeGroup: 0,
    ClusterMode: 'enabled',
    AutomaticFailoverEnabled: true,
    NumCacheClusters: 2,
    AutoMinorVersionUpgrade: true,
    IpDiscovery: 'ipv4',
    NetworkType: 'ipv4',
  };

  it('produces ZERO potential drift on a clean, un-mutated cluster-mode RG', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('folds the derived trio (ClusterMode / AutomaticFailoverEnabled / NumCacheClusters) to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    const atDefault = pathsByTier(f, 'atDefault');
    for (const p of ['ClusterMode', 'AutomaticFailoverEnabled', 'NumCacheClusters']) {
      expect(atDefault).toContain(p);
      expect(pathsByTier(f, 'undeclared')).not.toContain(p);
    }
  });

  it('surfaces an out-of-band shard/replica scale (NumCacheClusters away from NumNodeGroups*(1+replicas))', () => {
    const scaled = { ...cleanLive, NumCacheClusters: 4 };
    const f = classifyResource(res, scaled, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('NumCacheClusters');
    expect(pathsByTier(f, 'atDefault')).not.toContain('NumCacheClusters');
  });

  it('surfaces an out-of-band failover DISABLE on a cluster-mode RG', () => {
    const noFailover = { ...cleanLive, AutomaticFailoverEnabled: false };
    const f = classifyResource(res, noFailover, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('AutomaticFailoverEnabled');
    expect(pathsByTier(f, 'atDefault')).not.toContain('AutomaticFailoverEnabled');
  });

  it('surfaces an out-of-band ClusterMode divergence (live disabled vs declared cluster-mode shape)', () => {
    const migrated = { ...cleanLive, ClusterMode: 'disabled' };
    const f = classifyResource(res, migrated, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('ClusterMode');
    expect(pathsByTier(f, 'atDefault')).not.toContain('ClusterMode');
  });

  it('derives NumCacheClusters with a bigger replica count (2 shards x (1+1) = 4)', () => {
    const biggerRes: DesiredResource = {
      ...res,
      declared: { ...res.declared, ReplicasPerNodeGroup: 1 },
    };
    const live = { ...cleanLive, ReplicasPerNodeGroup: 1, NumCacheClusters: 4 };
    const f = classifyResource(biggerRes, live, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('NumCacheClusters');
    expect(pathsByTier(f, 'undeclared')).not.toContain('NumCacheClusters');
  });

  it('derives NumCacheClusters from a NodeGroupConfiguration (2 groups x (1+1) = 4)', () => {
    const ngcRes: DesiredResource = {
      logicalId: 'HuntNgcRg',
      resourceType: 'AWS::ElastiCache::ReplicationGroup',
      physicalId: 'huntngcrg',
      declared: {
        ReplicationGroupDescription: 'ngc rg',
        Engine: 'redis',
        CacheNodeType: 'cache.t4g.micro',
        NodeGroupConfiguration: [{ ReplicaCount: 1 }, { ReplicaCount: 1 }],
      },
    };
    const live = {
      ReplicationGroupDescription: 'ngc rg',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NodeGroupConfiguration: [{ ReplicaCount: 1 }, { ReplicaCount: 1 }],
      ClusterMode: 'enabled',
      AutomaticFailoverEnabled: true,
      NumCacheClusters: 4,
    };
    const f = classifyResource(ngcRes, live, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('NumCacheClusters');
    expect(pathsByTier(f, 'atDefault')).toContain('ClusterMode');
    expect(pathsByTier(f, 'undeclared')).not.toContain('NumCacheClusters');
  });
});

describe('#1500 ElastiCache::ReplicationGroup non-cluster + valkey engine axes', () => {
  it('a valkey RG folds AutomaticFailoverEnabled=true even without a cluster-mode shape', () => {
    const res: DesiredResource = {
      logicalId: 'HuntValkeyRg',
      resourceType: 'AWS::ElastiCache::ReplicationGroup',
      physicalId: 'huntvalkeyrg',
      declared: {
        ReplicationGroupDescription: 'valkey rg',
        Engine: 'valkey',
        CacheNodeType: 'cache.t4g.micro',
      },
    };
    const live = {
      ReplicationGroupDescription: 'valkey rg',
      Engine: 'valkey',
      CacheNodeType: 'cache.t4g.micro',
      AutomaticFailoverEnabled: true,
    };
    const f = classifyResource(res, live, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('AutomaticFailoverEnabled');
    expect(pathsByTier(f, 'undeclared')).not.toContain('AutomaticFailoverEnabled');
  });

  it('a non-cluster redis RG keeps ClusterMode=disabled folding via the KNOWN_DEFAULTS constant', () => {
    const res: DesiredResource = {
      logicalId: 'HuntPlainRg',
      resourceType: 'AWS::ElastiCache::ReplicationGroup',
      physicalId: 'huntplainrg',
      declared: {
        ReplicationGroupDescription: 'plain rg',
        Engine: 'redis',
        CacheNodeType: 'cache.t4g.micro',
      },
    };
    const live = {
      ReplicationGroupDescription: 'plain rg',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      ClusterMode: 'disabled',
    };
    const f = classifyResource(res, live, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('ClusterMode');
    expect(pathsByTier(f, 'undeclared')).not.toContain('ClusterMode');
  });
});

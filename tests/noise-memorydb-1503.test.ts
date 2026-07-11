// #1503: MemoryDB::Cluster first-run fold gaps mined from a clean, un-mutated LIVE deploy of a
// BAREST valkey cluster (stack Cdkrd1503..., us-east-1, 2026-07-12). The memorydb-rich (redis)
// fixture DECLARED the engine-independent shape/backup/TLS props, so their undeclared-default
// path never ran until this minimal valkey deploy surfaced five undeclared properties as
// [Potential Drift] on a first `check`:
//   NumShards / NumReplicasPerShard / SnapshotRetentionLimit -> tier-1 KNOWN_DEFAULTS constants
//     (a reshard / replica change / snapshot enable still surfaces).
//   TLSEnabled -> tier-1 KNOWN_DEFAULTS truthy-bool constant, paired with a MEANINGFUL_WHEN_OFF
//     gate so an out-of-band TLS DISABLE (undeclared false) still surfaces.
//   EngineVersion -> tier-3 VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS (AWS moves the auto-selected
//     GA patch over time, so a pinned constant rots; undeclared, so any value AWS returns is its
//     default, not user intent — the RDS/DocDB/Neptune/ElastiCache twin).
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

describe('#1503 MemoryDB::Cluster undeclared first-run defaults (barest valkey)', () => {
  const res: DesiredResource = {
    logicalId: 'HuntValkeyCluster',
    resourceType: 'AWS::MemoryDB::Cluster',
    physicalId: 'huntvalkeycluster',
    // The barest valkey CfnCluster: only these five props are declared.
    declared: {
      ClusterName: 'huntvalkeycluster',
      NodeType: 'db.t4g.small',
      ACLName: 'open-access',
      Engine: 'valkey',
      SubnetGroupName: 'huntsubnetgroup',
    },
  };
  // The clean live model of a fresh valkey cluster: the declared echoes plus every undeclared
  // default AWS materialized. Port/AutoMinorVersionUpgrade/DataTiering/NetworkType/IpDiscovery
  // were already pinned; the five #1503 additions are NumShards/NumReplicasPerShard/
  // SnapshotRetentionLimit/TLSEnabled/EngineVersion. MaintenanceWindow/SnapshotWindow are the
  // AWS-assigned random windows already folded value-independent.
  const cleanLive = {
    ClusterName: 'huntvalkeycluster',
    NodeType: 'db.t4g.small',
    ACLName: 'open-access',
    Engine: 'valkey',
    SubnetGroupName: 'huntsubnetgroup',
    Port: 6379,
    AutoMinorVersionUpgrade: true,
    DataTiering: 'false',
    NetworkType: 'ipv4',
    IpDiscovery: 'ipv4',
    NumShards: 1,
    NumReplicasPerShard: 1,
    SnapshotRetentionLimit: 0,
    TLSEnabled: true,
    EngineVersion: '7.3',
    MaintenanceWindow: 'sun:07:00-sun:08:00',
    SnapshotWindow: '05:00-06:00',
  };

  it('produces ZERO potential drift on a clean, un-mutated valkey cluster', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('folds the five undeclared defaults to atDefault', () => {
    const f = classifyResource(res, cleanLive, emptySchema);
    const atDefault = pathsByTier(f, 'atDefault');
    for (const p of [
      'NumShards',
      'NumReplicasPerShard',
      'SnapshotRetentionLimit',
      'TLSEnabled',
      'EngineVersion',
    ]) {
      expect(atDefault).toContain(p);
      expect(pathsByTier(f, 'undeclared')).not.toContain(p);
    }
  });

  it('folds EngineVersion value-independently (a different GA patch still folds)', () => {
    const moved = { ...cleanLive, EngineVersion: '7.9' };
    const f = classifyResource(res, moved, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('EngineVersion');
    expect(pathsByTier(f, 'undeclared')).not.toContain('EngineVersion');
  });

  it('surfaces an out-of-band reshard (NumShards away from the default)', () => {
    const changed = { ...cleanLive, NumShards: 3 };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('NumShards');
    expect(pathsByTier(f, 'atDefault')).not.toContain('NumShards');
  });

  it('surfaces an out-of-band snapshot-retention enable', () => {
    const changed = { ...cleanLive, SnapshotRetentionLimit: 7 };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('SnapshotRetentionLimit');
    expect(pathsByTier(f, 'atDefault')).not.toContain('SnapshotRetentionLimit');
  });

  it('surfaces an out-of-band TLS DISABLE (undeclared false, via MEANINGFUL_WHEN_OFF)', () => {
    // Without the AWS::MemoryDB::Cluster MEANINGFUL_WHEN_OFF gate the live `false` is dropped
    // by isTrivialEmpty before the pin gate, hiding the transit-encryption disable.
    const changed = { ...cleanLive, TLSEnabled: false };
    const f = classifyResource(res, changed, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('TLSEnabled');
    expect(pathsByTier(f, 'atDefault')).not.toContain('TLSEnabled');
  });
});

import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #818 — a fresh, un-mutated Valkey AWS::ElastiCache::ReplicationGroup violated the
// zero-first-run invariant with 3 potential-drift FPs (undeclared Port=6379,
// AtRestEncryptionEnabled=true (valkey-only), EngineVersion="9.1.0"). Port +
// AtRestEncryptionEnabled are now engine-derived (equality-gated) folds; the undeclared GA
// EngineVersion is value-independent. Detection preserved: an out-of-band port change or an
// at-rest-encryption DISABLE still surfaces.
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
const tier = (fs: Finding[], t: string): string[] =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'ValkeyRg',
  resourceType: 'AWS::ElastiCache::ReplicationGroup',
  physicalId: 'valkey-rg',
  declared,
});
const declaredMinimal = {
  Engine: 'valkey',
  CacheNodeType: 'cache.t4g.micro',
  NumCacheClusters: 1,
  AutomaticFailoverEnabled: false,
  TransitEncryptionEnabled: false,
  ReplicationGroupDescription: 'v',
};

describe('#818 Valkey ReplicationGroup first-run folds', () => {
  it('folds undeclared Port / AtRestEncryptionEnabled / EngineVersion to atDefault (zero FP)', () => {
    const f = classifyResource(
      mk(declaredMinimal),
      { ...declaredMinimal, Port: 6379, AtRestEncryptionEnabled: true, EngineVersion: '9.1.0' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['AtRestEncryptionEnabled', 'EngineVersion', 'Port'])
    );
    for (const p of ['Port', 'AtRestEncryptionEnabled', 'EngineVersion'])
      expect(tier(f, 'undeclared')).not.toContain(p);
  });

  it('a redis RG folds AtRestEncryptionEnabled=false (its engine default)', () => {
    const redis = { ...declaredMinimal, Engine: 'redis' };
    const f = classifyResource(
      mk(redis),
      { ...redis, Port: 6379, AtRestEncryptionEnabled: false },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['AtRestEncryptionEnabled', 'Port'])
    );
  });

  it('detection preserved: an out-of-band Port change surfaces (equality-gated, not blind)', () => {
    // Port is engine-derived + equality-gated, so a divergence from the 6379 default is
    // still real undeclared drift — the fold only quiets the exact default.
    const f = classifyResource(
      mk(declaredMinimal),
      { ...declaredMinimal, Port: 6380, AtRestEncryptionEnabled: true, EngineVersion: '9.1.0' },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('Port');
  });
  // (AtRestEncryptionEnabled is a create-only property on ElastiCache — it can only be set
  // at creation and never flips out of band — so the engine-derived equality-gate fold loses
  // no detection; there is no OOB-disable scenario to catch.)
});

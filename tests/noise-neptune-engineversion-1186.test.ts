import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #1186 — a fresh AWS::Neptune::DBCluster that declares NO EngineVersion reads back the
// current GA Neptune engine version AWS provisioned ("1.4.7.0" today), surfacing as an
// undeclared [Potential Drift] on a first check (core-invariant violation). It is the
// sibling of the DocDB / ElastiCache::ReplicationGroup EngineVersion folds: a moving GA
// version = the canonical value-independent (tier-3) case. Undeclared-only — a user who
// PINS a version declares it (compared in the declared loop; the partial-vs-concrete echo
// stays folded by VERSION_PREFIX_PATHS). The existing Neptune corpus case DECLARES
// EngineVersion, so it never covered this undeclared scenario.
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
const declaredMinimal = { DBSubnetGroupName: 'neptune-subnet-group' };
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Cluster',
  resourceType: 'AWS::Neptune::DBCluster',
  physicalId: 'neptune-cluster',
  declared,
});

describe('#1186 Neptune DBCluster undeclared EngineVersion fold', () => {
  it('folds the undeclared GA EngineVersion to atDefault (zero first-run FP)', () => {
    const f = classifyResource(
      mk(declaredMinimal),
      { ...declaredMinimal, EngineVersion: '1.4.7.0' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('EngineVersion');
    expect(tier(f, 'undeclared')).not.toContain('EngineVersion');
  });

  it('folds value-independent (any moving GA version folds, not just one pinned constant)', () => {
    const f = classifyResource(
      mk(declaredMinimal),
      { ...declaredMinimal, EngineVersion: '1.3.5.0' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('EngineVersion');
    expect(tier(f, 'undeclared')).not.toContain('EngineVersion');
  });
});

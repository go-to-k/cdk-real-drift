// First-run false-positive folds bundled from three fix(noise) issues, all landing in
// src/normalize/noise.ts. Each is an equality-gated / value-independent / case-fold entry,
// so every test asserts BOTH the fold (atDefault / no declared drift on a clean deploy) AND
// that a genuine divergence still surfaces.
//   #1451 — ELBv2 TargetGroup: TargetType constant + stickiness.enabled attribute-bag default.
//   #1457 — case-insensitive lowercase-identifier family (ElastiCache SubnetGroup live-anchor).
// #1453 (EC2 Subnet AvailabilityZone) is DEFERRED — it needs a forbidden classify.ts change
// (see the NOTE below and the PR description).
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

const declaredPaths = (findings: Finding[]) => pathsByTier(findings, 'declared');

const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({ logicalId: 'R', resourceType, physicalId, declared });

// #1451 (a) — TargetType constant
describe('#1451 ELBv2 TargetGroup TargetType default', () => {
  const T = 'AWS::ElasticLoadBalancingV2::TargetGroup';
  it('folds an undeclared TargetType "instance" to atDefault', () => {
    const f = classifyResource(
      mk(T, { Port: 80, Protocol: 'HTTP', VpcId: 'vpc-1' }),
      {
        Port: 80,
        Protocol: 'HTTP',
        VpcId: 'vpc-1',
        TargetType: 'instance',
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('TargetType');
    expect(pathsByTier(f, 'undeclared')).not.toContain('TargetType');
  });

  it('a declared lambda TargetType still compares (drift on a mismatch)', () => {
    const f = classifyResource(
      mk(T, { TargetType: 'lambda' }),
      { TargetType: 'instance' },
      emptySchema
    );
    expect(declaredPaths(f)).toContain('TargetType');
  });
});

// #1451 (b) — stickiness.enabled attribute-bag default
describe('#1451 ELBv2 TargetGroup stickiness.enabled attribute-bag default', () => {
  const T = 'AWS::ElasticLoadBalancingV2::TargetGroup';
  const withBag = (entries: { Key: string; Value: string }[]) => ({
    Port: 80,
    Protocol: 'HTTP',
    VpcId: 'vpc-1',
    TargetType: 'instance',
    TargetGroupAttributes: entries,
  });

  it('folds an undeclared stickiness.enabled "false" to atDefault', () => {
    const f = classifyResource(
      mk(T, { Port: 80, Protocol: 'HTTP', VpcId: 'vpc-1' }),
      withBag([{ Key: 'stickiness.enabled', Value: 'false' }]),
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('TargetGroupAttributes[stickiness.enabled]');
    expect(pathsByTier(f, 'undeclared')).not.toContain('TargetGroupAttributes[stickiness.enabled]');
  });

  it('an out-of-band stickiness ENABLE ("true") still surfaces as undeclared', () => {
    const f = classifyResource(
      mk(T, { Port: 80, Protocol: 'HTTP', VpcId: 'vpc-1' }),
      withBag([{ Key: 'stickiness.enabled', Value: 'true' }]),
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('TargetGroupAttributes[stickiness.enabled]');
    expect(pathsByTier(f, 'atDefault')).not.toContain('TargetGroupAttributes[stickiness.enabled]');
  });
});

// NOTE: #1453 (EC2 Subnet undeclared AvailabilityZone / AvailabilityZoneId) is intentionally
// NOT fixed in this PR — see the PR description. The tier-3 value-independent fold planned for
// it collides with the pre-existing AvailabilityZone/AvailabilityZoneId handling in
// classify.ts (CC_ALT_REPRESENTATION + its deliberate test), which is a forbidden file for this
// lane, so #1453 is deferred rather than shipped half-done.

// #1457 — case-insensitive lowercase-identifier family
describe('#1457 lowercase-identifier case-fold family', () => {
  it('ElastiCache SubnetGroup mixed-case name vs lowercase live is NOT declared drift', () => {
    const T = 'AWS::ElastiCache::SubnetGroup';
    const f = classifyResource(
      mk(T, { CacheSubnetGroupName: 'CdkrdHunt-EcSubnets', SubnetIds: ['subnet-1'] }),
      { CacheSubnetGroupName: 'cdkrdhunt-ecsubnets', SubnetIds: ['subnet-1'] },
      emptySchema
    );
    expect(declaredPaths(f)).not.toContain('CacheSubnetGroupName');
  });

  it('a genuinely different SubnetGroup name still surfaces as declared drift', () => {
    const T = 'AWS::ElastiCache::SubnetGroup';
    const f = classifyResource(
      mk(T, { CacheSubnetGroupName: 'group-aaa', SubnetIds: ['subnet-1'] }),
      { CacheSubnetGroupName: 'group-bbb', SubnetIds: ['subnet-1'] },
      emptySchema
    );
    expect(declaredPaths(f)).toContain('CacheSubnetGroupName');
  });

  it('the family covers DocDB / Neptune / DMS identifiers too', () => {
    const cases: [string, string, string, string][] = [
      ['AWS::DocDB::DBCluster', 'DBClusterIdentifier', 'MyDocDb-Cluster', 'mydocdb-cluster'],
      ['AWS::Neptune::DBInstance', 'DBInstanceIdentifier', 'MyGraph-DB', 'mygraph-db'],
      [
        'AWS::DMS::ReplicationInstance',
        'ReplicationInstanceIdentifier',
        'MyDms-Repl',
        'mydms-repl',
      ],
    ];
    for (const [T, prop, declared, live] of cases) {
      const f = classifyResource(mk(T, { [prop]: declared }), { [prop]: live }, emptySchema);
      expect(declaredPaths(f)).not.toContain(prop);
    }
  });
});

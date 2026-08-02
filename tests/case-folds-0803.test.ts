// 2026-08-03 hunt case-insensitivity additions (the #1712 stored-lowercased family),
// each backed by a live probe or carried-over owning evidence (see noise.ts comments):
//   - ElastiCache CacheParameterGroupName consumers (CacheCluster / ReplicationGroup):
//     raw CreateCacheParameterGroup stores `CdkrdHunt-Mixed-ECPG` as
//     `cdkrdhunt-mixed-ecpg` (live-probed); the association echo returns the stored name.
//   - ElastiCache UserGroup.UserIds / ReplicationGroup.UserGroupIds (ARRAY twins) +
//     ServerlessCache.UserGroupId: raw CreateUser stores mixed-case ids lowercased
//     (live-probed) while the CC handler rejects them — a template referencing a
//     CLI-created mixed-case id FPs on the consumer echo.
//   - Route53Resolver ResolverRule.DomainName: create-resolver-rule stores
//     `Mixed.Example.Com` as `mixed.example.com.` (live-probed).
//   - DAX Cluster ParameterGroupName / SubnetGroupName (consumers of the live-proven
//     DAX owning entries) + ClusterName (SDK-doc "stored as a lowercase string").
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

const declaredFindings = (f: Finding[]) => f.filter((x) => x.tier === 'declared');

const res = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({ logicalId: 'R', resourceType, physicalId, declared });

describe('2026-08-03 case-insensitive additions fold pure-case echoes', () => {
  it('ElastiCache CacheCluster.CacheParameterGroupName (consumer)', () => {
    const f = classifyResource(
      res('AWS::ElastiCache::CacheCluster', {
        ClusterName: 'cc1',
        Engine: 'redis',
        CacheParameterGroupName: 'CdkrdHunt-Mixed-ECPG',
      }),
      { ClusterName: 'cc1', Engine: 'redis', CacheParameterGroupName: 'cdkrdhunt-mixed-ecpg' },
      emptySchema
    );
    expect(declaredFindings(f)).toEqual([]);
  });

  it('ElastiCache ReplicationGroup.UserGroupIds (array consumer, order- and case-insensitive)', () => {
    const f = classifyResource(
      res('AWS::ElastiCache::ReplicationGroup', {
        ReplicationGroupId: 'rg1',
        UserGroupIds: ['CdkrdHunt-Mixed-UG', 'plain-ug'],
      }),
      { ReplicationGroupId: 'rg1', UserGroupIds: ['plain-ug', 'cdkrdhunt-mixed-ug'] },
      emptySchema
    );
    expect(declaredFindings(f)).toEqual([]);
  });

  it('ElastiCache UserGroup.UserIds still surfaces a genuine membership change', () => {
    const f = classifyResource(
      res('AWS::ElastiCache::UserGroup', {
        UserGroupId: 'ug1',
        Engine: 'redis',
        UserIds: ['CdkrdHunt-Mixed-User'],
      }),
      { UserGroupId: 'ug1', Engine: 'redis', UserIds: ['cdkrdhunt-mixed-user', 'extra-user'] },
      emptySchema
    );
    expect(declaredFindings(f).map((x) => x.path)).toEqual(['UserIds']);
  });

  it('Route53Resolver ResolverRule.DomainName (owning)', () => {
    const f = classifyResource(
      res('AWS::Route53Resolver::ResolverRule', {
        RuleType: 'SYSTEM',
        DomainName: 'Mixed.Example.Com',
      }),
      { RuleType: 'SYSTEM', DomainName: 'mixed.example.com' },
      emptySchema
    );
    expect(declaredFindings(f)).toEqual([]);
  });

  it('DAX Cluster name + group consumers', () => {
    const f = classifyResource(
      res('AWS::DAX::Cluster', {
        ClusterName: 'CdkrdHunt-Mixed-Dax',
        ParameterGroupName: 'CdkrdHunt-Mixed-DaxPG',
        SubnetGroupName: 'CdkrdHunt-Mixed-SNG',
      }),
      {
        ClusterName: 'cdkrdhunt-mixed-dax',
        ParameterGroupName: 'cdkrdhunt-mixed-daxpg',
        SubnetGroupName: 'cdkrdhunt-mixed-sng',
      },
      emptySchema
    );
    expect(declaredFindings(f)).toEqual([]);
  });
});

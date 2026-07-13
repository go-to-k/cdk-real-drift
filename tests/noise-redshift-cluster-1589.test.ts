// #1589 / #1590 — two first-run FPs on a barest Redshift Cluster, live-proven on
// case-idents3-min (us-east-1, 2026-07-14):
//   * ClusterIdentifier: the CFn handler accepts a mixed-case identifier and the
//     service stores/echoes it lowercased ("CdkrdHunt-Mixed-RsCluster" ->
//     "cdkrdhunt-mixed-rscluster") — the #1531 lowercase-echo family, on the
//     cluster itself (CASE_INSENSITIVE_PATHS).
//   * ClusterSubnetGroupName: a cluster declaring no subnet group (default-VPC
//     placement) reads back the literal "default" — an AWS creation-time constant
//     (KNOWN_DEFAULTS, equality-gated so an out-of-band move still surfaces).
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

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntRsCluster',
  resourceType: 'AWS::Redshift::Cluster',
  physicalId: 'cdkrdhunt-mixed-rscluster',
  declared,
});

const declared = {
  ClusterIdentifier: 'CdkrdHunt-Mixed-RsCluster',
  ClusterType: 'single-node',
  NodeType: 'ra3.large',
  DBName: 'huntdb',
  MasterUsername: 'huntadmin',
};

describe('#1589 Redshift Cluster lowercase-stored ClusterIdentifier', () => {
  it('a pure case-fold echo is not declared drift', () => {
    const f = classifyResource(
      mk(declared),
      { ...declared, ClusterIdentifier: 'cdkrdhunt-mixed-rscluster' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toEqual([]);
  });

  it('an identifier differing beyond case still surfaces as declared drift', () => {
    const f = classifyResource(
      mk(declared),
      { ...declared, ClusterIdentifier: 'cdkrdhunt-other' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toEqual(['ClusterIdentifier']);
  });
});

describe('#1590 Redshift Cluster default-VPC ClusterSubnetGroupName="default"', () => {
  it('the undeclared "default" subnet group folds to atDefault', () => {
    const f = classifyResource(
      mk(declared),
      {
        ...declared,
        ClusterIdentifier: 'cdkrdhunt-mixed-rscluster',
        ClusterSubnetGroupName: 'default',
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    expect(pathsByTier(f, 'atDefault')).toContain('ClusterSubnetGroupName');
  });

  it('an out-of-band move to a real subnet group still surfaces', () => {
    const f = classifyResource(
      mk(declared),
      {
        ...declared,
        ClusterIdentifier: 'cdkrdhunt-mixed-rscluster',
        ClusterSubnetGroupName: 'my-own-sng',
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['ClusterSubnetGroupName']);
  });
});

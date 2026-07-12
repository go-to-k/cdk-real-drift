// #660 item 1: the restore-risk `true`-default switches — RDS/ElastiCache/MemoryDB/Neptune
// `AutoMinorVersionUpgrade` and Redshift `AllowVersionUpgrade`. Each is a `true` KNOWN_DEFAULTS
// pin, so an undeclared out-of-band flip to `false` used to be swallowed by isTrivialEmpty
// before the pin gate (invisible / unrecordable / unrevertable — the #632 class). They now join
// MEANINGFUL_WHEN_OFF so the disable surfaces, BUT gated on the resource NOT being a snapshot
// restore: a restore INHERITS the source's flag, so a restore of a source that had it `false`
// reads back `false` UNTOUCHED — a creation-time value AWS assigned for an undeclared prop, not
// a divergence. LIVE-PROVEN 2026-07-12 (us-east-1): a MariaDB source with
// `--no-auto-minor-version-upgrade`, snapshotted, then `restore-db-instance-from-db-snapshot`
// with the flag UNDECLARED read back `AutoMinorVersionUpgrade=false` — restore inherits, it does
// NOT default to `true`. So the fix requires a `notRestored(...)` predicate, not `() => true`.
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

// Per type: the flag name and the restore-source property that, when declared, marks the
// resource as a snapshot/point-in-time restore (folds the inherited off-state instead of
// surfacing). Neptune::DBInstance has no instance-level restore source (undefined).
type Case = {
  resourceType: string;
  flag: string;
  restoreProp?: string;
  restoreValue?: unknown;
  baseDeclared: Record<string, unknown>;
};

const CASES: Case[] = [
  {
    resourceType: 'AWS::RDS::DBInstance',
    flag: 'AutoMinorVersionUpgrade',
    restoreProp: 'DBSnapshotIdentifier',
    restoreValue: 'my-snap',
    baseDeclared: { DBInstanceClass: 'db.t3.micro', Engine: 'mariadb' },
  },
  {
    resourceType: 'AWS::RDS::DBCluster',
    flag: 'AutoMinorVersionUpgrade',
    restoreProp: 'SnapshotIdentifier',
    restoreValue: 'my-cluster-snap',
    baseDeclared: { Engine: 'aurora-mysql' },
  },
  {
    resourceType: 'AWS::Neptune::DBInstance',
    flag: 'AutoMinorVersionUpgrade',
    // No instance-level restore source: unconditional, no restore case.
    baseDeclared: { DBInstanceClass: 'db.r5.large' },
  },
  {
    resourceType: 'AWS::ElastiCache::CacheCluster',
    flag: 'AutoMinorVersionUpgrade',
    restoreProp: 'SnapshotName',
    restoreValue: 'my-cache-snap',
    baseDeclared: { Engine: 'redis', CacheNodeType: 'cache.t3.micro' },
  },
  {
    resourceType: 'AWS::ElastiCache::ReplicationGroup',
    flag: 'AutoMinorVersionUpgrade',
    restoreProp: 'SnapshotName',
    restoreValue: 'my-rg-snap',
    baseDeclared: { Engine: 'redis', CacheNodeType: 'cache.t3.micro' },
  },
  {
    resourceType: 'AWS::MemoryDB::Cluster',
    flag: 'AutoMinorVersionUpgrade',
    restoreProp: 'SnapshotName',
    restoreValue: 'my-mdb-snap',
    baseDeclared: { NodeType: 'db.t4g.small', ACLName: 'open-access' },
  },
  {
    resourceType: 'AWS::Redshift::Cluster',
    flag: 'AllowVersionUpgrade',
    restoreProp: 'SnapshotIdentifier',
    restoreValue: 'my-redshift-snap',
    baseDeclared: { NodeType: 'ra3.large', ClusterType: 'single-node' },
  },
];

describe('#660 item 1 restore-risk version-upgrade booleans', () => {
  for (const c of CASES) {
    const mkRes = (declared: Record<string, unknown>): DesiredResource => ({
      logicalId: 'R',
      resourceType: c.resourceType,
      physicalId: 'r-phys',
      declared,
    });

    it(`${c.resourceType}: clean undeclared true folds atDefault (no first-run FP)`, () => {
      const f = classifyResource(
        mkRes(c.baseDeclared),
        { ...c.baseDeclared, [c.flag]: true },
        emptySchema
      );
      expect(pathsByTier(f, 'atDefault')).toContain(c.flag);
      expect(pathsByTier(f, 'undeclared')).not.toContain(c.flag);
    });

    it(`${c.resourceType}: out-of-band undeclared ${c.flag}=false surfaces (FN fix)`, () => {
      const f = classifyResource(
        mkRes(c.baseDeclared),
        { ...c.baseDeclared, [c.flag]: false },
        emptySchema
      );
      expect(pathsByTier(f, 'undeclared')).toContain(c.flag);
    });

    if (c.restoreProp) {
      const restoreProp = c.restoreProp;
      it(`${c.resourceType}: restored (${restoreProp} declared) undeclared ${c.flag}=false does NOT surface`, () => {
        // A restore inherits the source's false — a creation-time value, not a divergence.
        const declared = { ...c.baseDeclared, [restoreProp]: c.restoreValue };
        const f = classifyResource(mkRes(declared), { ...declared, [c.flag]: false }, emptySchema);
        expect(pathsByTier(f, 'undeclared')).not.toContain(c.flag);
      });
    } else {
      it(`${c.resourceType}: has no restore source — the disable always surfaces`, () => {
        // Neptune instances are created fresh even into a restored cluster, so false is always
        // an out-of-band disable.
        const f = classifyResource(
          mkRes(c.baseDeclared),
          { ...c.baseDeclared, [c.flag]: false },
          emptySchema
        );
        expect(pathsByTier(f, 'undeclared')).toContain(c.flag);
      });
    }
  }
});

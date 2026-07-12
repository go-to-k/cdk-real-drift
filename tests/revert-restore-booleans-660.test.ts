// #660 item 1 revert follow-up to PR #1520: detecting an out-of-band DISABLE of a restore-risk
// version-upgrade boolean (AutoMinorVersionUpgrade / AllowVersionUpgrade) is only half the fix —
// `revert` must also CONVERGE. Their modify APIs KEEP the existing value on an omitted flag, so a
// bare `remove` revert of the undeclared `false` is a silent no-op (`check` flags it, `revert`
// can't fix it). REVERT_SET_DEFAULT_PATHS routes each through the set-default fallback: write the
// `true` default (from KNOWN_DEFAULTS) explicitly instead of a `remove`. LIVE-PROVEN on
// RDS::DBInstance (Cdkrd660RevertVerify, us-east-1, 2026-07-12): pre-fix bare `remove` reported
// success yet `describe-db-instances` stayed AutoMinorVersionUpgrade=false; post-fix the
// set-default `add true` converged the live value back to true.
import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const CASES: { resourceType: string; flag: string }[] = [
  { resourceType: 'AWS::RDS::DBInstance', flag: 'AutoMinorVersionUpgrade' },
  { resourceType: 'AWS::RDS::DBCluster', flag: 'AutoMinorVersionUpgrade' },
  { resourceType: 'AWS::Neptune::DBInstance', flag: 'AutoMinorVersionUpgrade' },
  { resourceType: 'AWS::ElastiCache::CacheCluster', flag: 'AutoMinorVersionUpgrade' },
  { resourceType: 'AWS::ElastiCache::ReplicationGroup', flag: 'AutoMinorVersionUpgrade' },
  { resourceType: 'AWS::MemoryDB::Cluster', flag: 'AutoMinorVersionUpgrade' },
  { resourceType: 'AWS::Redshift::Cluster', flag: 'AllowVersionUpgrade' },
];

describe('#660 item 1 revert: restore-risk booleans converge via set-default, not remove', () => {
  for (const c of CASES) {
    it(`${c.resourceType} ${c.flag}=false reverts as set-default \`add true\`, NOT a remove`, () => {
      const f: Finding = {
        tier: 'undeclared',
        unrecorded: true,
        logicalId: 'R',
        physicalId: 'r-phys',
        resourceType: c.resourceType,
        path: c.flag,
        actual: false,
      };
      const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
      expect(plan.items).toHaveLength(1);
      // Without the REVERT_SET_DEFAULT_PATHS entry this would be `{ op: 'remove' }`, which the
      // modify API ignores (a silent no-op) — the live disable would stay disabled.
      expect(plan.items[0]!.ops[0]).toMatchObject({
        op: 'add',
        path: `/${c.flag}`,
        value: true,
      });
    });
  }
});

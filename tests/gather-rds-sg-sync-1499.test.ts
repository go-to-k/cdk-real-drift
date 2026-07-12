// #1499 / #640: the RDS/DocDB (and, discovered on the same lane, EC2::Instance) VPC-default-SG folds
// were registered in classify DEFAULT_SG_LIST_PATHS (AWS::RDS::DBCluster VpcSecurityGroupIds /
// AWS::RDS::DBInstance VPCSecurityGroups / AWS::DocDB::DBCluster VpcSecurityGroupIds /
// AWS::EC2::Instance SecurityGroupIds) but MISSING from gather DEFAULT_SG_LIST_TYPES. For a stack
// containing only such a type the default-SG prefetch never fired → opts.defaultSgIds stayed empty →
// shouldFoldDefaultSgList failed OPEN (folds any value) → an out-of-band SG swap/append was silently
// NOT detected. This is the classify/gather sync twin of the #1492 Redshift fix (PR #1511). The
// mechanical sync-guard at the bottom asserts the whole class (every classify path key ⊆ the gather
// prefetch set) so a future addition to one table that forgets the other cannot recur.
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_SG_LIST_TYPES } from '../src/commands/gather.js';
import {
  classifyResource,
  DEFAULT_SG_LIST_PATHS,
  shouldFoldDefaultSgList,
} from '../src/diff/classify.js';
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

const DEFAULT_SG = 'sg-0a26e23e2310ee0c9';
const ROGUE_SG = 'sg-0deadbeefdeadbeef';
const tierOf = (findings: Finding[], path: string) => findings.find((f) => f.path === path)?.tier;

// Each newly-registered type + its API SG-list property key (RDS DBInstance uses the legacy plural).
const CASES: { type: string; key: string }[] = [
  { type: 'AWS::RDS::DBCluster', key: 'VpcSecurityGroupIds' },
  { type: 'AWS::RDS::DBInstance', key: 'VPCSecurityGroups' },
  { type: 'AWS::DocDB::DBCluster', key: 'VpcSecurityGroupIds' },
  { type: 'AWS::EC2::Instance', key: 'SecurityGroupIds' },
];

describe('#1499 RDS/DocDB default-SG gate: classify/gather sync', () => {
  for (const { type, key } of CASES) {
    describe(type, () => {
      const res: DesiredResource = {
        logicalId: 'Db',
        resourceType: type,
        physicalId: 'huntdb',
        // A resource that declares no security groups (the barest shape).
        declared: {},
      };
      const defaultSgIds = new Set([DEFAULT_SG]);

      it('gather registers the type so the default-SG prefetch fires (classify/gather sync)', () => {
        // Miss the gather side and the prefetch never fires → defaultSgIds empty → the fold fails
        // open → an OOB SG swap/append is silently NOT detected. Keep classify + gather in sync.
        expect(DEFAULT_SG_LIST_TYPES.has(type)).toBe(true);
      });

      it('folds a single VPC-default SG to atDefault (undeclared, gated)', () => {
        const f = classifyResource(res, { [key]: [DEFAULT_SG] }, emptySchema, { defaultSgIds });
        expect(tierOf(f, key)).toBe('atDefault');
      });

      it('surfaces an out-of-band SG APPEND (2-element list)', () => {
        const f = classifyResource(res, { [key]: [DEFAULT_SG, ROGUE_SG] }, emptySchema, {
          defaultSgIds,
        });
        expect(tierOf(f, key)).toBe('undeclared');
      });

      it('surfaces an out-of-band SG SWAP (single non-default SG)', () => {
        const f = classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, { defaultSgIds });
        expect(tierOf(f, key)).toBe('undeclared');
      });

      it('shouldFoldDefaultSgList: fold the default, surface the swap, fail open when unresolved', () => {
        expect(shouldFoldDefaultSgList(type, key, [DEFAULT_SG], defaultSgIds)).toBe(true);
        expect(shouldFoldDefaultSgList(type, key, [DEFAULT_SG, ROGUE_SG], defaultSgIds)).toBe(
          false
        );
        expect(shouldFoldDefaultSgList(type, key, [ROGUE_SG], defaultSgIds)).toBe(false);
        // Fail open: no prefetched ids (empty set) → keep folding so a clean deploy gains no FP.
        expect(shouldFoldDefaultSgList(type, key, [ROGUE_SG], new Set())).toBe(true);
      });
    });
  }
});

// Mechanical sync-guard for the WHOLE class (#1499/#640 root cause): the derived VPC-default-SG
// gate only preserves OOB swap/append detection if gather PREFETCHES the default-SG ids, which it
// does exactly when a declared resource type is in DEFAULT_SG_LIST_TYPES. So every type classify
// gates in DEFAULT_SG_LIST_PATHS MUST also be in gather DEFAULT_SG_LIST_TYPES — otherwise the
// prefetch never fires for a single-such-type stack and the gate silently fails open (the FN this
// lane fixed for RDS/DocDB/EC2::Instance). Assert the subset so adding a type to one table but
// forgetting the other fails here instead of shipping a silent detection gap.
describe('classify/gather default-SG registration sync-guard', () => {
  it('every DEFAULT_SG_LIST_PATHS type is registered in gather DEFAULT_SG_LIST_TYPES', () => {
    const missing = Object.keys(DEFAULT_SG_LIST_PATHS).filter((t) => !DEFAULT_SG_LIST_TYPES.has(t));
    expect(missing).toEqual([]);
  });
});

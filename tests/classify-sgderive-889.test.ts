// #889 — UNDECLARED, MUTABLE default security-group lists (ALB SecurityGroups / ENI GroupSet)
// were folded VALUE-INDEPENDENT (tier 3), which HID an out-of-band SG swap/append (a security
// boundary an attacker could widen and read CLEAN forever). classify now DERIVE-gates them against
// the account/region VPC-default SG ids (prefetched by gather.ts into opts.defaultSgIds):
//   - a single VPC-default SG folds atDefault (the clean-deploy default);
//   - a 2+-element APPEND or a single NON-default SG SWAP surfaces as potential (undeclared) drift;
//   - a lookup FAILURE (defaultSgIds absent/empty) FAILS OPEN → folds (no new first-run FP).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource, shouldFoldDefaultSgList } from '../src/diff/classify.js';
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
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

// The one VPC-default SG the account/region prefetch resolved.
const DEFAULT_SG = 'sg-0defau1t00000000';
const ANOTHER_DEFAULT_SG = 'sg-0defau1t99999999'; // a second VPC's default SG (also in the set)
const ROGUE_SG = 'sg-0rogue00000000000'; // an attacker-attached wide-open SG (not a default)
const defaultSgIds = new Set([DEFAULT_SG, ANOTHER_DEFAULT_SG]);

// (resourceType, undeclared-SG-list key) pairs the gate covers.
const CASES: Array<{ label: string; type: string; key: string }> = [
  { label: 'ENI GroupSet', type: 'AWS::EC2::NetworkInterface', key: 'GroupSet' },
  {
    label: 'ALB SecurityGroups',
    type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    key: 'SecurityGroups',
  },
];

for (const { label, type, key } of CASES) {
  describe(`#889 ${label} derived VPC-default-SG gate`, () => {
    // The resource declares NO security groups (so the live list is UNDECLARED and reaches the fold).
    const res = mk(type, { Description: 'x' });

    it('(a) folds a single VPC-default SG to atDefault (clean deploy, no drift)', () => {
      const f = classifyResource(res, { [key]: [DEFAULT_SG] }, emptySchema, { defaultSgIds });
      expect(tier(f, 'atDefault')).toContain(key);
      expect(tier(f, 'undeclared')).not.toContain(key);
    });

    it('(b) SURFACES a 2-element list (out-of-band SG append)', () => {
      const f = classifyResource(res, { [key]: [DEFAULT_SG, ROGUE_SG] }, emptySchema, {
        defaultSgIds,
      });
      expect(tier(f, 'undeclared')).toContain(key);
      expect(tier(f, 'atDefault')).not.toContain(key);
    });

    it('(c) SURFACES a single NON-default SG (out-of-band SG swap)', () => {
      const f = classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, { defaultSgIds });
      expect(tier(f, 'undeclared')).toContain(key);
      expect(tier(f, 'atDefault')).not.toContain(key);
    });

    it('(d) FOLDS on lookup failure (defaultSgIds absent → fail open, no first-run FP)', () => {
      // No opts.defaultSgIds (prefetch unavailable / ec2:DescribeSecurityGroups denied): even a
      // rogue two-element list folds — fail-open keeps today's value-independent behavior so a
      // clean deploy never gains a first-run false positive.
      const f = classifyResource(res, { [key]: [ROGUE_SG, DEFAULT_SG] }, emptySchema, {});
      expect(tier(f, 'atDefault')).toContain(key);
      expect(tier(f, 'undeclared')).not.toContain(key);
    });

    it('folds a single SG from ANY VPC default in the set', () => {
      const f = classifyResource(res, { [key]: [ANOTHER_DEFAULT_SG] }, emptySchema, {
        defaultSgIds,
      });
      expect(tier(f, 'atDefault')).toContain(key);
    });
  });
}

describe('#889 shouldFoldDefaultSgList (pure decision)', () => {
  it('folds a single default SG, surfaces append/swap, and fails open when unresolved', () => {
    const t = 'AWS::EC2::NetworkInterface';
    // single default → fold
    expect(shouldFoldDefaultSgList(t, 'GroupSet', [DEFAULT_SG], defaultSgIds)).toBe(true);
    // append (2 elements) → surface
    expect(shouldFoldDefaultSgList(t, 'GroupSet', [DEFAULT_SG, ROGUE_SG], defaultSgIds)).toBe(
      false
    );
    // single non-default (swap) → surface
    expect(shouldFoldDefaultSgList(t, 'GroupSet', [ROGUE_SG], defaultSgIds)).toBe(false);
    // fail open: no resolved ids → fold
    expect(shouldFoldDefaultSgList(t, 'GroupSet', [ROGUE_SG], undefined)).toBe(true);
    expect(shouldFoldDefaultSgList(t, 'GroupSet', [ROGUE_SG], new Set())).toBe(true);
    // a non-gated (type, key) pair is not this gate's business
    expect(shouldFoldDefaultSgList(t, 'PrivateIpAddress', ['10.0.0.1'], defaultSgIds)).toBe(false);
  });
});

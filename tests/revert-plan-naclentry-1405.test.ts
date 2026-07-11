import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1405: an out-of-band `added` AWS::EC2::NetworkAclEntry (surfaced by #1315) must be
// reported as notRevertable UP FRONT — Cloud Control has no DeleteResource handler for the
// type, so a `delete`-kind item would fail only at apply with UnsupportedActionException
// (live-observed: "Resource type AWS::EC2::NetworkAclEntry does not support DELETE action").
const addedFinding = (over: Partial<Finding>): Finding => ({
  tier: 'added',
  logicalId: 'Rogue',
  physicalId: 'acl-0decc27dd4a85e726|50|false',
  resourceType: 'AWS::EC2::NetworkAclEntry',
  path: '',
  unrecorded: true,
  ...over,
});

describe('buildRevertPlan — #1405 CC-delete-unsupported added types', () => {
  it('an added NetworkAclEntry is notRevertable up front under --remove-unrecorded (no delete op)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('Cloud Control cannot delete');
    expect(plan.notRevertable[0]!.resourceType).toBe('AWS::EC2::NetworkAclEntry');
  });

  it('without --remove-unrecorded it is the ordinary unrecorded gate (never a silent delete)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
  });

  it('a CC-deletable added sibling (SubnetRouteTableAssociation) STILL builds a delete item', () => {
    // control: the gate must be scoped to the unsupported type only — the other #1315
    // sub-resources revert cleanly via CC DeleteResource.
    const f = addedFinding({
      logicalId: 'RogueAssoc',
      resourceType: 'AWS::EC2::SubnetRouteTableAssociation',
      physicalId: 'rtbassoc-09eeac6b454391d81',
    });
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('delete');
  });
});

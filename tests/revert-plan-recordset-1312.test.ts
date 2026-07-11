import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1312 → #1431: an out-of-band `added` AWS::Route53::RecordSet (surfaced by the HostedZone
// child enumerator) is NON_PROVISIONABLE — Cloud Control has NO DeleteResource handler, so it
// was originally reported `notRevertable` up front (#1312). #1431 adds a Route53
// `ChangeResourceRecordSets` DELETE SDK deleter (SDK_DELETERS), so the type has GRADUATED out of
// CC_DELETE_UNSUPPORTED_ADDED_TYPES: a `delete`-kind item is now built under --remove-unrecorded
// and routed to that SDK deleter by stack-actions (the actual SDK call is unit-tested in
// route53-recordset-delete-1431.test.ts). The unrecorded / recorded-added GATES are unchanged.
const addedFinding = (over: Partial<Finding>): Finding => ({
  tier: 'added',
  logicalId: 'Zone/Z1234567890ABC_rogue.example.mytld._A',
  physicalId: 'Z1234567890ABC_rogue.example.mytld._A',
  resourceType: 'AWS::Route53::RecordSet',
  path: '',
  unrecorded: true,
  ...over,
});

describe('buildRevertPlan — #1431 added Route53::RecordSet is revertable via the SDK deleter', () => {
  it('builds a delete-kind item under --remove-unrecorded (graduated out of CC-delete-unsupported)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('delete');
    expect(plan.items[0]!.resourceType).toBe('AWS::Route53::RecordSet');
    expect(plan.items[0]!.physicalId).toBe('Z1234567890ABC_rogue.example.mytld._A');
  });

  it('without --remove-unrecorded it is the ordinary unrecorded gate (never a silent delete)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
  });
});

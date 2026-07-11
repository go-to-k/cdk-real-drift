import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1312: an out-of-band `added` AWS::Route53::RecordSet (surfaced by the HostedZone child
// enumerator) must be reported as notRevertable UP FRONT — the type is NON_PROVISIONABLE per
// describe-type, so Cloud Control has NO DeleteResource handler and a `delete`-kind item would
// fail only at apply with UnsupportedActionException. Its real delete would flow through the
// Route53 `ChangeResourceRecordSets` API (a DELETE change action), not CC.
const addedFinding = (over: Partial<Finding>): Finding => ({
  tier: 'added',
  logicalId: 'RogueRecord',
  physicalId: 'Z1234567890ABC|example.mytld.|A',
  resourceType: 'AWS::Route53::RecordSet',
  path: '',
  unrecorded: true,
  ...over,
});

describe('buildRevertPlan — #1312 CC-delete-unsupported added Route53::RecordSet', () => {
  it('an added RecordSet is notRevertable up front under --remove-unrecorded (no delete op)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('Cloud Control cannot delete');
    expect(plan.notRevertable[0]!.resourceType).toBe('AWS::Route53::RecordSet');
  });

  it('without --remove-unrecorded it is the ordinary unrecorded gate (never a silent delete)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
  });
});

import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1312: an out-of-band `added` AWS::Route53::RecordSet is surfaced by the HostedZone child
// enumerator. The type is NON_PROVISIONABLE per describe-type, so Cloud Control has NO
// DeleteResource handler. #1312 / PR #1427 first reported it notRevertable up front (the honest
// bar). #1431 then wired the real delete through a type-specific SDK deleter (Route53
// `ChangeResourceRecordSets` Action DELETE, in SDK_DELETERS), so a type with an SDK deleter is
// now EXEMPT from that bar — under --remove-unrecorded it builds a `delete`-kind item that
// routes through the SDK deleter at apply (see route53-record-endorse-delete-1431.test.ts for
// the deleter + record-endorse coverage).
const addedFinding = (over: Partial<Finding>): Finding => ({
  tier: 'added',
  logicalId: 'RogueRecord',
  physicalId: 'Z1234567890ABC_example.mytld._A',
  resourceType: 'AWS::Route53::RecordSet',
  path: '',
  unrecorded: true,
  ...over,
});

describe('buildRevertPlan — added Route53::RecordSet (#1312 bar → #1431 SDK-deleter delete)', () => {
  it('under --remove-unrecorded it builds a delete-kind item (SDK-deleter exempt from the #1405 bar)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('delete');
    expect(plan.items[0]!.resourceType).toBe('AWS::Route53::RecordSet');
  });

  it('without --remove-unrecorded it is the ordinary unrecorded gate (never a silent delete)', () => {
    const f = addedFinding({});
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('unrecorded');
  });
});

import { describe, expect, it } from 'vite-plus/test';
import { revertConfirmMessage } from '../src/commands/stack-actions.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #764: a RECORDED (endorsed) `added` out-of-band resource that later CHANGED stays tier
// `added` with `unrecorded` UNSET and the recorded baseline model on `desired` (applyBaseline
// tags it "changed since record"). Its only revert lever is DeleteResource of the WHOLE
// resource. Before the fix, `revert --yes` (which skips the interactive multiselect's
// unselected-by-default `(DELETE)` rows) planned that delete straight away and DELETED an
// endorsed out-of-band DBInstance/ECS Service with no delete-specific gate. The fix requires
// the same `--remove-unrecorded` opt-in the unrecorded-added branch already uses.

// A recorded-added-that-changed finding, as applyBaseline produces it: tier `added`,
// path '', `desired` carrying the recorded baseline model, `unrecorded` UNSET.
const recordedAddedChanged = (): Finding => ({
  tier: 'added',
  logicalId: 'Cluster/reader-xyz',
  physicalId: 'reader-xyz',
  resourceType: 'AWS::RDS::DBInstance',
  path: '',
  actual: { DBInstanceClass: 'db.r6g.2xlarge' }, // changed live value
  desired: { DBInstanceClass: 'db.r6g.large' }, // recorded baseline model
  note: 'changed since record',
});

describe('#764 recorded-added delete gate', () => {
  it('a recorded added resource that changed is NOT deletable under --yes without --remove-unrecorded (gated to notRevertable)', () => {
    const f = recordedAddedChanged();
    const plan = buildRevertPlan([f], undefined);
    // NO delete item is emitted — the destructive delete is gated behind the opt-in.
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('recorded added resource changed since record');
    expect(plan.notRevertable[0]!.reason).toContain('--remove-unrecorded');
  });

  it('with --remove-unrecorded the same finding DOES produce a delete-kind item', () => {
    const f = recordedAddedChanged();
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      kind: 'delete',
      physicalId: 'reader-xyz',
      resourceType: 'AWS::RDS::DBInstance',
    });
    expect(plan.items[0]!.ops[0]!.human).toContain('DELETE');
  });

  it('an UNRECORDED added resource stays gated by --remove-unrecorded (unchanged behavior)', () => {
    const f: Finding = {
      tier: 'added',
      logicalId: 'Cluster/reader-abc',
      physicalId: 'reader-abc',
      resourceType: 'AWS::RDS::DBInstance',
      path: '',
      unrecorded: true,
    };
    const noFlag = buildRevertPlan([f], undefined);
    expect(noFlag.items).toHaveLength(0);
    expect(noFlag.notRevertable[0]!.reason).toContain('unrecorded');
    const plan = buildRevertPlan([f], undefined, { removeUnrecorded: true });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('delete');
  });
});

describe('#764 revertConfirmMessage names the DELETE count', () => {
  it('mentions how many ops DELETE a whole out-of-band resource', () => {
    const msg = revertConfirmMessage('s', 'us-east-1', 3, 0, 2);
    expect(msg).toContain('2 of these DELETE(S) a whole out-of-band resource');
    expect(msg).toContain('WRITES to AWS');
  });

  it('says nothing about deletes when there are none (backward compatible)', () => {
    const msg = revertConfirmMessage('s', 'us-east-1', 2, 0);
    expect(msg).not.toContain('DELETE');
    expect(msg).toBe('Apply 2 revert op(s) to s (us-east-1)? This WRITES to AWS.');
  });
});
